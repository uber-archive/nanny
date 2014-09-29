'use strict';

// A single cluster supervisor instance oversees a collection of worker
// supervisors and load balancers.
// The worker supervisors ensure that workers remain up.
// The load balancers distribute connections to workers that are listening on a
// shared port.

var debuglog = require('debuglog');
var os = require('os');

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

    this.workers = [];
    this._runningWorkerCount = 0;
    this.loadBalancers = {}; // port to LoadBalancer

    if (!options.exec) throw new Error('missing exec');
    if (Array.isArray(options.logicalIds) && options.logicalIds.length !== this.numCPUs) {
        throw new Error('mismatching logicalIds length and numCPUs');
    }
}

ClusterSupervisor.prototype.LoadBalancer = require('./round-robin-load-balancer');
ClusterSupervisor.prototype.WorkerSupervisor = require('./worker-supervisor');

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
        var worker = this.WorkerSupervisor(this, logicalId);
        worker.start();
        this.workers.push(worker);
    }

    TERM_SIGNALS.forEach(function (signal) {
        process.on(signal, function () {
            this.logger.info('cluster master received signal...killing workers', {
                signal: signal
            });

            self.stop();
            // TODO exit only when all workers have verifiably shut down
            process.exit();
        }.bind(this));
    }.bind(this));

    if (this.initMaster) this.initMaster();

};

ClusterSupervisor.prototype.stop = function (callback) {
    this.stopAllWorkers();
    Object.keys(this.loadBalancers).forEach(function (port) {
        var listener = this.loadBalancers[port];
        listener.stop();
    }, this);
    // ... in anticipation of other resources that may need to be cleaned up
    // before the supervisor can exit gracefully.
    if (callback) {
        process.nextTick(callback);
    }
};

ClusterSupervisor.prototype.stopAllWorkers = function () {
    this.workers.forEach(function (worker) {
        worker.stop();
    });
};

ClusterSupervisor.prototype.countWorkers = function () {
    return this.workers.length;
};

// This returns the number of workers that "should" be running and does not
// reflect whether they have shut down yet.
ClusterSupervisor.prototype.countRunningWorkers = function () {
    return this._runningWorkerCount;
};

ClusterSupervisor.prototype.forEachWorker = function (callback, thisp) {
    this.workers.forEach(function (worker, index) {
        callback.call(thisp, worker, index, this);
    }, this);
};

ClusterSupervisor.prototype._addWorkerSupervisorToLoadBalancer = function (workerSupervisor, port, address, backlog) {
    var loadBalancer = this.loadBalancers[port];
    if (!loadBalancer) {
        loadBalancer = new this.LoadBalancer(this, port, address, backlog);
        this.loadBalancers[port] = loadBalancer;
    } else {
        // Verify that all workers are listening with the same parameters for a
        // given port or pipename.
        if (loadBalancer.address !== address) {
            this.logger.warn('worker listening on same port but requested alternate address', {
                id: workerSupervisor.id,
                port: port,
                address: address
            });
        } else if (loadBalancer.backlog !== backlog) {
            this.logger.warn('worker listening on same port but requested alternate backlog', {
                id: workerSupervisor.id,
                port: port,
                backlog: backlog
            });
        }
    }
    loadBalancer.addWorkerSupervisor(workerSupervisor);
};

module.exports = ClusterSupervisor;

