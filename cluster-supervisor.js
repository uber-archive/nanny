'use strict';

// A single cluster supervisor instance oversees a collection of worker
// supervisors and load balancers.
// The worker supervisors ensure that workers remain up.
// The load balancers distribute connections to workers that are listening on a
// shared port.

var os = require('os');
var events = require('events');
var util = require('util');
var WorkerSupervisor = require('./worker-supervisor');
var LoadBalancer = require('./round-robin-load-balancer');

var logger; // lazy = require('debuglog')('nanny');
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

    this.logicalIds = this.configureLogicalIds(spec);

    this.exec = spec.exec; // Worker module path TODO rename modulePath
    this.args = spec.args || []; // Worker arguments TODO rename argv or something

    if (!spec.logger) {
        if (!logger) {
            logger = require('debuglog')('nanny');
        }
        spec.logger = {
            error: logger,
            warn: logger,
            info: logger,
            debug: logger
        };
    }
    this.logger = spec.logger;

    // The period between when a server errors out and stops and when we
    // attempt to restart it:
    this.serverRestartDelay = spec.serverRestartDelay;
    this.spec = spec;

    this.workers = [];
    this.loadBalancers = {}; // port to LoadBalancer

    if (!spec.exec) throw new Error('missing exec');

    // Event handlers bound to this instance
    this.handleWorkerListenRequest = this.handleWorkerListenRequest.bind(this);
    this.handleWorkerCloseRequest = this.handleWorkerCloseRequest.bind(this);
    this.handleWorkerBounce = this.handleWorkerBounce.bind(this);
    this.handleWorkerStandby = this.handleWorkerStandby.bind(this);
    this.handleLoadBalancerStandby = this.handleLoadBalancerStandby.bind(this);
    this.checkForFullStop = this.checkForFullStop.bind(this);

}

util.inherits(ClusterSupervisor, events.EventEmitter);

ClusterSupervisor.prototype.defaultWorkerForceStopDelay = 5000;
ClusterSupervisor.prototype.LoadBalancer = LoadBalancer;
ClusterSupervisor.prototype.WorkerSupervisor = WorkerSupervisor;

// ## Commands

// The start command spins up all the workers and the workers in turn spin up
// any needed load balancers.
ClusterSupervisor.prototype.start = function start () {
    this._initMaster();
};

// The stop command shuts down all workers and load balancers.
// The given callback will be informed when all systems return to a standby
// state.
ClusterSupervisor.prototype.stop = function (callback) {
    this.forEachWorker(function (worker) {
        worker.stop();
    });
    this.forEachLoadBalancer(function (loadBalancer) {
        loadBalancer.stop();
    }, this);
    if (callback) {
        this.once('standby', callback);
        // This will emit standby immediately if the cluster is already fully
        // stopped.
        process.nextTick(this.checkForFullStop);
    }
};

// ## Inspecting the cluster

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

ClusterSupervisor.prototype.countWorkers = function () {
    return this.workers.length;
};

ClusterSupervisor.prototype.countActiveWorkers = function () {
    return this.inspect().workers.filter(function (worker) {
        return worker.state !== 'standby';
    }).length;
};

ClusterSupervisor.prototype.countActiveLoadBalancers = function () {
    return this.inspect().loadBalancers.filter(function (loadBalancer) {
        return loadBalancer.state !== 'standby';
    }).length;
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

// ## Internals

// Thus ends the public interface of the ClusterSupervisor and begins its
// internals.

ClusterSupervisor.prototype._initMaster = function _initMaster () {
    var self = this;

    this.logger.info('initing master', {
        title: process.title,
        logicalIds: this.logicalIds
    });

    this.logicalIds.forEach(function (logicalId) {
        this._spawnWorker(logicalId);
    }, this);

    TERM_SIGNALS.forEach(function (signal) {
        process.once(signal, function () {
            this.logger.info('cluster master received signal...killing workers', {
                title: process.title,
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
    var spec = this.spec;
    var worker = this.WorkerSupervisor({
        id: logicalId,
        logger: this.logger,
        // Fork spec:
        workerPath: spec.exec, // TODO rename exec to workerPath
        cwd: spec.cwd,
        encoding: spec.encoding,
        execPath: spec.execPath,
        execArgv: spec.execArgv,
        silent: spec.silent,
        // Supervisor spec:
        pulse: spec.pulse,
        restartDelay: spec.workerRestartDelay,
        forceStopDelay: spec.workerForceStopDelay ||
            this.defaultWorkerForceStopDelay,
        createEnvironment: spec.createEnvironment,
        isHealthy: spec.isHealthy,
        unhealthyTimeout: spec.unhealthyTimeout
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
    var activeWorkerCount = this.countActiveWorkers();
    var activeLoadBalancerCount = this.countActiveLoadBalancers();
    this.logger.debug('cluster status', {
        title: process.title,
        activeWorkerCount: activeWorkerCount,
        activeLoadBalancerCount: activeLoadBalancerCount
    });
    if (activeWorkerCount === 0 && activeLoadBalancerCount === 0) {
        this.logger.debug('cluster now standing by', {title: process.title});
        this.emit('standby');
    }
};

// Called by the constructor to funnel the various configuration cases into an
// array of logical identifiers for each worker.
// The user may provide either their own logicalIds array, a number of CPUs,
// or neither.
// If the user provides neither, we infer the number of CPUs.
// A number of CPUs produces a range of logical identifiers in the range [0,
// workerCount).
ClusterSupervisor.prototype.configureLogicalIds = function (spec) {
    var hasLogicalIds = Array.isArray(spec.logicalIds);
    var hasNumCPUs = typeof spec.workerCount !== 'undefined';
    if (hasLogicalIds && hasNumCPUs) {
        throw new Error('Can\'t configure ClusterSupervisor with both logicalIds and workerCount. Pick one');
    } else if (hasLogicalIds) {
        return spec.logicalIds;
    } else if (hasNumCPUs) {
        return ClusterSupervisor.range(spec.workerCount);
    } else {
        return os.cpus().map(function (cpu, index) {
            return index;
        });
    }
};

// A utility for producing a half-open interval [0, length) as an array.
ClusterSupervisor.range = function (length) {
    var range = [];
    for (var index = 0; index < length; index++) {
        range.push(index);
    }
    return range;
};

module.exports = ClusterSupervisor;

