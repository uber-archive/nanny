var cluster = require('cluster');
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
    this.initMaster = options.initMaster;
    this.numCPUs = options.numCPUs || os.cpus().length;
    this.logicalIds = options.logicalIds || [];
    this.exec = options.exec;
    this.args = options.args || [];
    this.logger = options.logger || {
        error: logger,
        warn: logger,
        info: logger,
        debug: logger
    };

    if (!options.exec) throw new Error('missing exec');
    if (Array.isArray(options.logicalIds) && options.logicalIds.length !== this.numCPUs) {
        throw new Error('mismatching logicalIds length and numCPUs');
    }
}

ClusterSupervisor.prototype.start = function start () {
    this._initMaster();
};

ClusterSupervisor.prototype._initMaster = function _initMaster () {
    var self = this;

    this.logger.info('initing master', {
        title: process.title,
        numCPUs: this.numCPUs
    });

    cluster.setupMaster({
        exec: this.exec,
        args: this.args
    });

    for(var i = 0; i < this.numCPUs; i++) {
        var logicalId;
        logicalId = this.logicalIds[i];
        this._spawnWorker(logicalId);
    }

    cluster.on('fork', function (worker) {
        this.logger.debug('cluster fork', {
            id: worker.id
        });
    }.bind(this));

    cluster.on('setup', function () {
        this.logger.debug('cluster setup');
    }.bind(this));

    TERM_SIGNALS.forEach(function (signal) {
        process.on(signal, function () {
            this.logger.info('cluster master received signal...killing workers', {
                signal: signal
            });

            self.stop();
            process.exit();
        }.bind(this));
    }.bind(this));

    if (this.initMaster) this.initMaster();

};

ClusterSupervisor.prototype.stop = function () {
    this.stopAllWorkers();
    // ... in anticipation of other resources that may need to be cleaned up
    // before the supervisor can exit gracefully.
};

ClusterSupervisor.prototype.stopAllWorkers = function () {
    Object.keys(cluster.workers).forEach(function (id) {
        // TODO hook into worker state machine
        cluster.workers[id].kill("SIGTERM");
    });
};

// TODO forceStopAllWorkers
// TODO dumpAllWorkers
// TODO reloadAllWorkers

ClusterSupervisor.prototype.countWorkers = function () {
    return Object.keys(cluster.workers).length;
};

ClusterSupervisor.prototype._spawnWorker = function _spawnWorker (logicalId) {
    var worker = cluster.fork({
        PROCESS_LOGICAL_ID: logicalId
    });

    this.logger.debug('spawning worker', {
        title: process.title
    });

    worker.on('exit', function (code, signal) {
        this.logger.debug('spawned worker exit', {
            pid: worker.process.pid,
            id: worker.id,
            code: code,
            signal: signal
        });

        if (this.respawnWorkerCount > 0 || this.respawnWorkerCount === -1) {
            if (this.respawnWorkerCount > 0) this.respawnWorkerCount--;

            this._spawnWorker(logicalId);
        }
    }.bind(this));

    worker.on('disconnect', function () {
        this.logger.debug('spawned worker disconnected', {
            id: worker.id
        });
    }.bind(this));

    worker.on('listening', function (address) {
        this.logger.debug('spawned worker listening', {
            id: worker.id,
            address: address
        });
    }.bind(this));

    worker.on('online', function () {
        this.logger.debug('spawned worker is online', {
            id: worker.id
        });
    }.bind(this));

    worker.on('message', function (message) {
        this.logger.debug('spawned worker got message', {
            id: worker.id,
            message: message
        });
    }.bind(this));
};

module.exports = ClusterSupervisor;

