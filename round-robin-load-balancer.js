'use strict';

var net = require('net');
var events = require('events');
var util = require('util');

// TODO server state machine, standby, starting, running, stopping
// handle connections and server stop and close events based on state
// TODO Close listener when there are no pending connections.
// TODO or queue incoming connections when there are no workers listening.
// TODO Redistribute connections that were rejected by a worker.
// TODO Remove a worker from rotation if it rejects a connection.
// TODO Refactor the arguments into options

function RoundRobinLoadBalancer(logger, port, address, backlog) {
    if (!(this instanceof RoundRobinLoadBalancer)) {
        return new RoundRobinLoadBalancer(logger, port, address, backlog);
    }
    this.logger = logger;
    this.port = port;
    var server = net.createServer();
    this.server = server;
    this.requestedAddress = address;
    this.requestedBacklog = backlog;
    this.address = null;
    this.ring = this.Ring();

    // Workers that are awaiting a 'listening' or 'error' message.
    this.waitingWorkers = [];

    this.handleListening = this.handleListening.bind(this);
    this.handleConnection = this.handleConnection.bind(this);
    this.handleError = this.handleError.bind(this);
    this.handleClose = this.handleClose.bind(this);

    server.on('listening', this.handleListening);
    server.on('connection', this.handleConnection);
    server.on('error', this.handleError);
    server.on('close', this.handleClose);

    this.logger.debug('listening for connections on behalf of workers', {
        port: this.port
    });
    this.server.listen(this.port, this.address, this.backlog);
}

util.inherits(RoundRobinLoadBalancer, events.EventEmitter);

RoundRobinLoadBalancer.prototype.Ring = Array; // TODO require('./_ring');

RoundRobinLoadBalancer.prototype.addWorkerSupervisor = function (workerSupervisor) {
    this.ring.push(workerSupervisor);
    this.logger.debug('worker subscribed to connections', {
        id: workerSupervisor.id,
        port: this.port,
        count: this.ring.length
    });
    if (this.waitingWorkers) {
        this.waitingWorkers.push(workerSupervisor);
    } else {
        workerSupervisor.sendAddress(this.port, this.address);
    }
};

// TODO RoundRobinLoadBalancer.prototype.removeWorkerSupervisor = function (workerSupervisor) {

RoundRobinLoadBalancer.prototype.handleListening = function () {
    this.address = this.server.address();
    this.logger.debug('server started on behalf of workers', {
        port: this.port,
        address: this.address
    });
    if (this.waitingWorkers) {
        // Inform all workers that they are now listening and the name of their
        // actual address.
        this.waitingWorkers.forEach(function (workerSupervisor) {
            workerSupervisor.sendAddress(this.port, this.address);
        }, this);
        this.waitingWorkers = null;
    }
};

RoundRobinLoadBalancer.prototype.handleError = function (error) {
    this.logger.debug('broadcasting server error to workers', {
        port: this.port,
        error: error
    });
    this.ring.forEach(function (workerSupervisor) {
        workerSupervisor.sendError(this.port, error);
    }, this);
    this.stop();
};

RoundRobinLoadBalancer.prototype.handleConnection = function (connection) {
    var workerSupervisor = this.ring.shift();
    this.ring.push(workerSupervisor);
    workerSupervisor.handleConnection(this.port, connection);
};

RoundRobinLoadBalancer.prototype.handleClose = function () {
    this.logger.debug('shared server closed', {
        port: this.port
    });
    this.emit('close', this);
    // TODO hook into state machine
};

RoundRobinLoadBalancer.prototype.stop = function () {
    this.logger.debug('shared server stop requested', {
        port: this.port
    });
    this.server.close();
    this.emit('stop', this);
    // TODO hook into state machine
};

module.exports = RoundRobinLoadBalancer;

