'use strict';

// A worker supervisor is an object that ensures that a worker process remains
// running, restarting the child process if necessary, and forwarding requests
// for network connections to the appropriate load balancer.

var childProcess = require('child_process');
var path = require('path');

function WorkerSupervisor(supervisor, id) {
    if (!(this instanceof WorkerSupervisor)) {
        return new WorkerSupervisor(supervisor, id);
    }
    this.supervisor = supervisor;
    this.logger = supervisor.logger;
    this.id = id;
    this.process = null;
    this.listeners = {};
}

WorkerSupervisor.prototype.start = function () {

    var supervisor = this.supervisor;

    var workerArgs = supervisor.args || [];
    var workerEnv = {
        PROCESS_LOGICAL_ID: this.id
    };
    var workerOptions = {
        cwd: supervisor.cwd,
        env: workerEnv,
        encoding: supervisor.encoding,
        execPath: supervisor.execPath,
        execArgv: supervisor.execArgv,
        silent: supervisor.silent,
    };
    var workerPath = supervisor.exec; // TODO rename exec to workerPath
    var workerPulse = supervisor.pulse;

    var worker = childProcess.fork(path.join(__dirname, '_worker'), workerArgs, workerOptions);
    this.process = worker;

    worker.send({cmd: 'CLUSTER_START', modulePath: workerPath, pulse: workerPulse});

    worker.on('exit', function (code, signal) {
        this.logger.debug('spawned worker exit', {
            pid: this.process.pid,
            id: this.id,
            code: code,
            signal: signal
        });

        if (this.respawnWorkerCount > 0 || this.respawnWorkerCount === -1) {
            if (this.respawnWorkerCount > 0) this.respawnWorkerCount--;
            this._spawnWorker(this.id);
        }

    }.bind(this));

    worker.on('message', function (message) {
        this.handleMessage(message);
    }.bind(this));

    this.supervisor._runningWorkerCount++;
};

WorkerSupervisor.prototype.stop = function () {
    // TODO integrate with worker state machine
    this.process.kill('SIGTERM');

    this.supervisor._runningWorkerCount--;
};

WorkerSupervisor.prototype.handleMessage = function (message) {
    //this.logger.debug('spawned worker got message', {
    //    id: this.id,
    //    message: message
    //});
    if (message.cmd === 'CLUSTER_LISTEN') {
        this.handleListenRequest(message.port, message.address, message.backlog);
    }
    // TODO handle CLUSTER_REJECT if a connection was sent to the worker but
    // rejected.
};

WorkerSupervisor.prototype.handleConnection = function (port, connection) {
    this.logger.debug('sending connection to worker', {
        id: this.id,
        port: port
    });
    this.process.send({
        cmd: 'CLUSTER_ACCEPT',
        port: port
    }, connection);
};

// Called by the load balancer to inform a Server in the Worker process that it
// has or has not received an address.
WorkerSupervisor.prototype.sendAddress = function (error, port, address) {
    if (error) {
        this.logger.error('informing worker that listening failed', {
            error: error.message
        });
    } else {
        this.logger.debug('informing worker that listening succeeded', {
            port: port,
            address: address
        });
    }
    this.process.send({
        cmd: 'CLUSTER_LISTENING',
        error: error,
        port: port,
        address: address
    });
};

WorkerSupervisor.prototype.handleListenRequest = function (port, address, backlog) {
    this.supervisor._addWorkerSupervisorToLoadBalancer(this, port, address, backlog);
};

module.exports = WorkerSupervisor;

