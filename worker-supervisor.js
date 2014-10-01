'use strict';

// A worker supervisor is an object that ensures that a worker process remains
// running, restarting the child process if necessary, and forwarding requests
// for network connections to the appropriate load balancer.

var events = require('events');
var childProcess = require('child_process');
var path = require('path');
var util = require('util');

function WorkerSupervisor(supervisor, id) {
    if (!(this instanceof WorkerSupervisor)) {
        return new WorkerSupervisor(supervisor, id);
    }
    this.supervisor = supervisor;
    this.logger = supervisor.logger;
    this.id = id;
    this.process = null;
    this.listeners = {};

    // Pre-bind event handlers
    this.handleMessage = this.handleMessage.bind(this);
    this.handleExit = this.handleExit.bind(this);
}

util.inherits(WorkerSupervisor, events.EventEmitter);

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

    worker.on('exit', this.handleExit);
    worker.on('message', this.handleMessage);

    // TODO the following can go away when the worker state machine lands
    this.supervisor._runningWorkerCount++;
};

WorkerSupervisor.prototype.stop = function () {
    // TODO integrate with worker state machine
    this.process.kill('SIGTERM');

    // TODO the following can go away when the worker state machine lands
    this.supervisor._runningWorkerCount--;
};

WorkerSupervisor.prototype.handleExit = function (code, signal) {
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
};

WorkerSupervisor.prototype.handleMessage = function (message) {
    // TODO This produces a lot of noise. Perhaps we need another log name.
    //this.logger.debug('spawned worker got message', {
    //    id: this.id,
    //    message: message
    //});
    if (message.cmd === 'CLUSTER_LISTEN') {
        this.emit('listen', message.port, message.address, message.backlog, this);
    }
    // TODO handle CLUSTER_PULSE and record worker health
    // TODO handle CLUSTER_REJECT if a connection was sent to the worker but
    // rejected.
    // TODO handle CLUSTER_CLOSE when a worker closes a server and needs to be
    // removed from the load balancer rotation.
    // TODO handle CLUSTER_RETURN_ERROR when an error is sent to a server on a
    // worker but that server has closed.
    // TODO handle CLUSTER_NOT_LISTENING when a worker has stopped listening
    // for connections before it receives its listening message
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
// has received an address.
WorkerSupervisor.prototype.sendAddress = function (port, address) {
    this.logger.debug('sending worker\'s server its listening address', {
        // TODO identify the exact server instance that should receive this
        // address so a thrashing worker doesn't get confused.
        port: port,
        address: address
    });
    this.process.send({
        cmd: 'CLUSTER_LISTENING',
        port: port,
        address: address
    });
};

// Called by the load balancer if its server emits an error, broadcasting that
// error to all attached servers.
WorkerSupervisor.prototype.sendError = function (port, error) {
    // TODO handle aberrant case where error is not actually an Error object.
    this.process.send({
        cmd: 'CLUSTER_ERROR',
        port: port,
        message: error.message
    });
};

module.exports = WorkerSupervisor;

