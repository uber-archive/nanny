'use strict';

var net = require('net');

// TODO Close listener when there are no pending connections.
// TODO or queue incoming connections when there are no workers listening.
// TODO Redistribute connections that were rejected by a worker.
// TODO Remove a worker from rotation if it rejects a connection.

function RoundRobinLoadBalancer(clusterSupervisor, port, address, backlog) {
    if (!(this instanceof RoundRobinLoadBalancer)) {
        return new RoundRobinLoadBalancer(clusterSupervisor, port);
    }
    this.clusterSupervisor = clusterSupervisor;
    this.port = port;
    this.logger = clusterSupervisor.logger;
    var server = net.createServer();
    this.server = server;
    this.address = address;
    this.backlog = backlog;
    this.ring = this.Ring();

    // Workers that are awaiting a 'listening' or 'error' message.
    // These three properties, the handleListening method, and the handleError
    // method, constitute a hand-rolled promise for a listening address.
    this.waitingWorkers = [];
    this.address = null;
    this.error = null;

    this.handleListening = this.handleListening.bind(this);
    this.handleConnection = this.handleConnection.bind(this);
    this.handleError = this.handleError.bind(this);

    server.on('listening', this.handleListening);
    server.on('connection', this.handleConnection);
    server.on('error', this.handleError);

    this.logger.debug('listening for connections on behalf of workers', {
        port: this.port
    });
    this.server.listen(this.port, this.address, this.backlog);
}

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
        workerSupervisor.sendAddress(this.error, this.port, this.address);
    }
};

RoundRobinLoadBalancer.prototype.handleListening = function () {
    this.address = this.server.address();
    this.logger.debug('server started on behalf of workers', {
        port: this.port,
        address: this.address
    });
    if (this.waitingWorkers) {
        this.waitingWorkers.forEach(function (workerSupervisor) {
            workerSupervisor.sendAddress(this.error, this.port, this.address);
        }, this);
        this.waitingWorkers = null;
    }
};

RoundRobinLoadBalancer.prototype.handleError = function (error) {
    this.error = error;
    this.logger.debug('server failed to start on behalf of workers', {
        port: this.port,
        error: error
    });
    if (this.waitingWorkers) {
        this.waitingWorkers.forEach(function (workerSupervisor) {
            workerSupervisor.sendAddress(this.error, this.port, this.address);
        }, this);
        this.waitingWorkers = null;
    }
};

RoundRobinLoadBalancer.prototype.handleConnection = function (connection) {
    this.logger.debug('server started on behalf of workers', {
        port: this.port
    });
    var workerSupervisor = this.ring.shift();
    this.ring.push(workerSupervisor);
    workerSupervisor.handleConnection(this.port, connection);
};

RoundRobinLoadBalancer.prototype.stop = function () {
    this.server.close();
};

module.exports = RoundRobinLoadBalancer;

