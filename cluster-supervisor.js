'use strict';

// A single cluster supervisor instance oversees a collection of worker
// supervisors and load balancers.
// The worker supervisors ensure that workers remain up.
// The load balancers distribute connections to workers that are listening on a
// shared port.

var debuglog = require('debuglog');
var os = require('os');
var events = require('events');
var util = require('util');
var WorkerSupervisor = require('./worker-supervisor');
var LoadBalancer = require('./round-robin-load-balancer');

var logger = debuglog('clustermon');
var TERM_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

function ClusterSupervisor(options) {
    if (!(this instanceof ClusterSupervisor)) {
        return new ClusterSupervisor(options);
    }

    options = options || {};

    this.respawnWorkerCount = options.respawnWorkerCount !== undefined ?
        options.respawnWorkerCount :
        -1;
    this.initMaster = options.initMaster; // Post-initialization hook, receives this, but no arguments
    this.numCPUs = options.numCPUs || os.cpus().length;
    this.logicalIds = options.logicalIds || [];
    this.exec = options.exec; // Worker module path TODO rename modulePath
    this.args = options.args || []; // Worker arguments TODO rename argv or something
    this.execPath = options.execPath; // alternate Node.js exec path
    this.execArgs = options.execArgv; // alternate Node.js arguments
    this.logger = options.logger || {
        error: logger,
        warn: logger,
        info: logger,
        debug: logger
    };
    this.pulse = options.pulse; // The period of heart beats expected from workers
    this.patience = options.patience; // The period between requesting a stop and automatically forcing a stop
    this.autoRestartDelay = options.autoRestartDelay; // The period between a worker death and starting it up again

    this.workers = [];
    this.loadBalancers = {}; // port to LoadBalancer

    if (!options.exec) throw new Error('missing exec');
    if (Array.isArray(options.logicalIds) && options.logicalIds.length !== this.numCPUs) {
        throw new Error('mismatching logicalIds length and numCPUs');
    }

    // Event handlers bound to this instance
    this.handleWorkerListenRequest = this.handleWorkerListenRequest.bind(this);
}

util.inherits(ClusterSupervisor, events.EventEmitter);

ClusterSupervisor.prototype.LoadBalancer = LoadBalancer;
ClusterSupervisor.prototype.WorkerSupervisor = WorkerSupervisor;

ClusterSupervisor.prototype.inspect = function () {
    return {
        workers: this.workers.map(function (worker) {
            return worker.inspect();
        })
    };
};

ClusterSupervisor.prototype.start = function start () {
    this._initMaster();
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
    var worker = this.WorkerSupervisor(this, logicalId);
    worker.on('listen', this.handleWorkerListenRequest);
    worker.start();
    this.workers.push(worker);
};

ClusterSupervisor.prototype.stop = function (callback) {
    this.forEachWorker(function (worker) {
        worker.stop();
    });
    this.forEachLoadBalancer(function (loadBalancer) {
        loadBalancer.stop();
    }, this);
    // TODO wait for all workers to stop before dispatching callback
    // ... in anticipation of other resources that may need to be cleaned up
    // before the supervisor can exit gracefully.
    if (callback) {
        process.nextTick(callback);
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
};

ClusterSupervisor.prototype._createLoadBalancer = function (port, address, backlog) {
    var loadBalancer = this.LoadBalancer(this.logger, port, address, backlog);
    return loadBalancer;
};

module.exports = ClusterSupervisor;

