'use strict';

// A single cluster supervisor instance oversees a collection of worker
// supervisors and load balancers.
// The worker supervisors ensure that workers remain up.
// The load balancers distribute connections to workers that are listening on a
// shared port.

// TODO note that workers emit 'health'. We do not use this internally.

var debuglog = require('debuglog');
var os = require('os');
var events = require('events');
var util = require('util');
var WorkerSupervisor = require('./worker-supervisor');
var LoadBalancer = require('./round-robin-load-balancer');

var logger = debuglog('clustermon');
var TERM_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

function ClusterSupervisor(spec) {
    if (!(this instanceof ClusterSupervisor)) {
        return new ClusterSupervisor(spec);
    }
    if (typeof spec !== 'object' || spec === null) {
        throw new Error('ClusterSupervisor requires a spec argument');
    }

    this.respawnWorkerCount = spec.respawnWorkerCount !== undefined ?
        spec.respawnWorkerCount :
        -1;
    this.initMaster = spec.initMaster; // Post-initialization hook, receives this, but no arguments
    this.numCPUs = spec.numCPUs || os.cpus().length;
    this.logicalIds = spec.logicalIds || [];
    this.exec = spec.exec; // Worker module path TODO rename modulePath
    this.args = spec.args || []; // Worker arguments TODO rename argv or something
    this.execPath = spec.execPath; // alternate Node.js exec path
    this.execArgs = spec.execArgv; // alternate Node.js arguments
    this.logger = spec.logger || {
        error: logger,
        warn: logger,
        info: logger,
        debug: logger
    };
    // The period of heart beats expected from workers:
    this.pulse = spec.pulse;
    // The period between requesting a stop and automatically forcing a stop:
    this.workerForceStopDelay = spec.workerForceStopDelay;
    // The period between a worker death and starting it up again:
    this.workerRestartDelay = spec.workerRestartDelay;
    // The period between when a server errors out and stops and when we
    // attempt to restart it:
    this.serverRestartDelay = spec.serverRestartDelay;

    this.workers = [];
    this.loadBalancers = {}; // port to LoadBalancer

    if (!spec.exec) throw new Error('missing exec');
    if (Array.isArray(spec.logicalIds) && spec.logicalIds.length !== this.numCPUs) {
        throw new Error('mismatching logicalIds length and numCPUs');
    }

    // Event handlers bound to this instance
    this.handleWorkerListenRequest = this.handleWorkerListenRequest.bind(this);
    this.handleWorkerCloseRequest = this.handleWorkerCloseRequest.bind(this);
    this.handleWorkerBounce = this.handleWorkerBounce.bind(this);
    this.handleWorkerStandby = this.handleWorkerStandby.bind(this);
    this.handleLoadBalancerStandby = this.handleLoadBalancerStandby.bind(this);
}

util.inherits(ClusterSupervisor, events.EventEmitter);

ClusterSupervisor.prototype.LoadBalancer = LoadBalancer;
ClusterSupervisor.prototype.WorkerSupervisor = WorkerSupervisor;

ClusterSupervisor.prototype.start = function start () {
    this._initMaster();
};

ClusterSupervisor.prototype.stop = function (callback) {
    this.forEachWorker(function (worker) {
        worker.stop();
    });
    this.forEachLoadBalancer(function (loadBalancer) {
        loadBalancer.stop();
    }, this);
    if (callback) {
        this.once('standby', callback);
    }
};

ClusterSupervisor.prototype.countWorkers = function () {
    return this.workers.length;
};

ClusterSupervisor.prototype.countRunningWorkers = function () {
    return this.inspect().workers.filter(function (worker) {
        return worker.state === 'running';
    }).length;
};

ClusterSupervisor.prototype.countRunningLoadBalancers = function () {
    return this.inspect().loadBalancers.filter(function (loadBalancer) {
        return loadBalancer.state === 'running';
    }).length;
};

ClusterSupervisor.prototype.forEachWorker = function (callback, thisp) {
    this.workers.forEach(function (worker, index) {
        callback.call(thisp, worker, index, this);
    }, this);
};

ClusterSupervisor.prototype.forEachLoadBalancer = function (callback, thisp) {
    Object.keys(this.loadBalancers).forEach(function (port) {
        var loadBalancer = this.loadBalancers[port];
        callback.call(thisp, loadBalancer, port, this);
    }, this);
};


// Thus ends the public interface of the ClusterSupervisor and begins its
// internals.

// Produces a snap shot of a data structure describing the state of the entire
// cluster, including all open ports and all workers.
ClusterSupervisor.prototype.inspect = function () {
    return {
        workers: this.workers.map(function (worker) {
            return worker.inspect();
        }),
        loadBalancers: Object.keys(this.loadBalancers).map(function (port) {
            return this.loadBalancers[port].inspect();
        }, this)
    };
};

ClusterSupervisor.prototype._initMaster = function _initMaster () {
    var self = this;

    this.logger.info('initing master', {
        title: process.title,
        numCPUs: this.numCPUs
    });

    for(var i = 0; i < this.numCPUs; i++) {
        var logicalId;
        logicalId = this.logicalIds[i] || i;
        this._spawnWorker(logicalId);
    }

    TERM_SIGNALS.forEach(function (signal) {
        process.on(signal, function () {
            this.logger.info('cluster master received signal...killing workers', {
                signal: signal
            });
            self.stop(function () {
                process.exit();
            });
        }.bind(this));
    }.bind(this));

    if (this.initMaster) this.initMaster();
};

ClusterSupervisor.prototype._spawnWorker = function (logicalId) {
    var worker = this.WorkerSupervisor({
        id: logicalId,
        logger: this.logger,
        // Fork spec:
        workerPath: this.exec, // TODO rename exec to workerPath
        cwd: this.cwd,
        encoding: this.encoding,
        execPath: this.execPath,
        execArgv: this.execArgv,
        silent: this.silent,
        // Supervisor spec:
        pulse: this.pulse,
        restartDelay: this.workerRestartDelay,
        forceStopDelay: this.workerForceStopDelay
    });
    worker.on('listen', this.handleWorkerListenRequest);
    worker.on('close', this.handleWorkerCloseRequest);
    worker.on('bounce', this.handleWorkerBounce);
    worker.on('standby', this.handleWorkerStandby);
    worker.start();
    this.workers.push(worker);
};

ClusterSupervisor.prototype.handleWorkerListenRequest = function (port, address, backlog, workerSupervisor) {
    var loadBalancer = this.loadBalancers[port];
    if (!loadBalancer) {
        loadBalancer = this._createLoadBalancer(port, address, backlog);
        this.loadBalancers[port] = loadBalancer;
    } else {
        // Verify that all workers are listening with the same parameters for a
        // given port or pipename.
        if (loadBalancer.requestedAddress !== address) {
            workerSupervisor.sendError(
                port,
                new Error(
                    'Can\'t listen on cluster-shared port ' +
                    'with alternate address: expected ' +
                    loadBalancer.requestedAddress + ' got ' + address
                )
            );
            return;
        } else if (loadBalancer.requestedBacklog !== backlog) {
            workerSupervisor.sendError(
                port,
                new Error(
                    'Can\'t listen on cluster-shared port ' +
                    'with alternate backlog: expected ' +
                    loadBalancer.requestedBacklog + ' got ' + backlog
                )
            );
            return;
        }
    }
    loadBalancer.addWorkerSupervisor(workerSupervisor);
    workerSupervisor.addLoadBalancer(loadBalancer);
};

ClusterSupervisor.prototype.handleWorkerCloseRequest = function (port, workerSupervisor) {
    var loadBalancer = this.loadBalancers[port];
    loadBalancer.removeWorkerSupervisor(workerSupervisor);
    workerSupervisor.removeLoadBalancer(loadBalancer);
};

// Called when a worker emits a 'bounce' message, indicating that a worker
// returned a connection because the server closed before it could receive the
// connection.
ClusterSupervisor.prototype.handleWorkerBounce = function (port, connection) {
    var loadBalancer = this.loadBalancers[port];
    loadBalancer.handleConnection(connection);
};

ClusterSupervisor.prototype._createLoadBalancer = function (port, address, backlog) {
    var loadBalancer = this.LoadBalancer({
        logger: this.logger,
        port: port,
        address: address,
        backlog: backlog,
        restartDelay: this.serverRestartDelay
    });
    loadBalancer.on('standby', this.handleLoadBalancerStandby);
    return loadBalancer;
};

// Called when a worker emits 'standby' indicating that it has stopped
ClusterSupervisor.prototype.handleWorkerStandby = function (workerSupervisor) {
    workerSupervisor.forEachLoadBalancer(function (loadBalancer) {
        loadBalancer.removeWorkerSupervisor(workerSupervisor);
        workerSupervisor.removeLoadBalancer(loadBalancer);
    });
    this.checkForFullStop();
};

// Called when a load balancer emits 'standby' indicating that it has stopped
ClusterSupervisor.prototype.handleLoadBalancerStandby = function (loadBalancer) {
    loadBalancer.forEachWorkerSupervisor(function (workerSupervisor) {
        workerSupervisor.removeLoadBalancer(loadBalancer);
        loadBalancer.removeWorkerSupervisor(workerSupervisor);
    });
    this.checkForFullStop();
};

// Called when either a worker or load balancer enters stand-by mode. When both
// populations are entirely on standby, the cluster is at standby.
ClusterSupervisor.prototype.checkForFullStop = function () {
    if (this.countRunningWorkers() === 0 && this.countRunningLoadBalancers() === 0) {
        this.emit('standby');
    }
};

module.exports = ClusterSupervisor;

