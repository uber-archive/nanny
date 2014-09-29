'use strict';

// This module duck-punches the Node.js `net` module, replacing its `Server`,
// such that we can intercept all requests to start and stop servers, forward
// them to the supervisor, and receive connections through the Node.js process
// IPC channel.
//
// We considered creating wrappers for the Node.js `net`, `http`, and `https`
// modules that would intercept all attempts to create TCP connections through
// the various levels of indirection, but Node.js does not expose a way to
// override the underlying `net` module.
// We may return to explore this design direction in another iteration.

var net = require('net');
var events = require('events');
var util = require('util');

var servers = {}; // Indexed by port.
// These are mutually recursive and JSHint likes them declared before use:
var tick, tock;
var tickTime, pulse;

// ## Communication with the supervisor

process.on('message', function (message, handle) {
    if (typeof message !== 'object' || message === null) {
        return;
    }
    if (message.cmd === 'CLUSTER_START') {
        process.emit('worker-start', message.modulePath, message.pulse);
    } else if (message.cmd === 'CLUSTER_ACCEPT') {
        process.emit('worker-accept', message.port, handle);
    } else if (message.cmd === 'CLUSTER_LISTENING') {
        process.emit('worker-listening', message.error, message.port, message.address);
    }
});

// The supervisor will immediately send a request to start running a worker
// module and kick off the configured heart beat.
process.on('worker-start', function (modulePath, newPulse) {
    require(modulePath);
    pulse = newPulse;
    if (pulse) {
        tick();
    }
});

process.on('worker-accept', function (port, handle) {
    var server = servers[port];
    if (server) {
        server.emit('connection', handle);
    } else {
        // Return to sender if the server no longer exists
        process.send({cmd: 'CLUSTER_REJECT', port: port}, handle);
    }
});

process.on('worker-listening', function (error, port, address) {
    var server = servers[port];
    if (error) {
        if (server) {
            server.emit('error', error);
        }
    } else {
        if (server) {
            server._address = address;
            server.emit('listening', server);
        }
    }
    // There is not much we can do if a listening message is sent to a server
    // that does not exist.
});

// ## Heart beat health check

// Here follows the mechanism for periodically sending health checks to the
// supervisor over the Node.js IPC channel.

// Marks the start time and schedules the next pulse.
tick = function () {
    tickTime = process.hrtime();
    setTimeout(tock, pulse);
};

// Measures the actual duration of the pulse and transmits health metrics to
// the supervisor.
// The load measures the average amount of time that the event loop blocked the
// scheduled pulse.
tock = function () {
    var tockPeriod = process.hrtime(tickTime);
    process.send({
        cmd: 'CLUSTER_PULSE',
        load: (tockPeriod[0] * 1e3 + tockPeriod[1] / 1e6) - pulse,
        memoryUsage: process.memoryUsage()
    });
    tick();
};

// ## Subverting the Node.js network stack

// The following replaces the TCP server that sits at the base of the Node.js
// networking stack, allowing the supervisor to take over the responsibility of
// distributing connections.

// This began its life as a an excerpt of the Node.js networking stack from
// version 0.12.

net.createServer = function createServer() {
  return new net.Server(arguments[0], arguments[1]);
};

function Server(/* [ options, ] listener */) {
    if (!(this instanceof Server)) return new Server(arguments[0], arguments[1]);
    events.EventEmitter.call(this);

    var self = this;

    var options;

    if (isFunction(arguments[0])) {
        options = {};
        self.on('connection', arguments[0]);
    } else {
        options = arguments[0] || {};
        if (isFunction(arguments[1])) {
            self.on('connection', arguments[1]);
        }
    }

    this.allowHalfOpen = options.allowHalfOpen || false;
}
util.inherits(Server, events.EventEmitter);
net.Server = Server;

// Intercept all attempts to listen on this server and redirect them to the
// cluster supervisor.
Server.prototype.listen = function () {
    var self = this;

    var lastArg = arguments[arguments.length - 1];
    if (typeof lastArg === 'function') {
        self.once('listening', lastArg);
    }

    var port = toNumber(arguments[0]);

    // The third optional argument is the backlog size.
    // When the ip is omitted it can be the second argument.
    var backlog = toNumber(arguments[1]) || toNumber(arguments[2]);

    var TCP = process.binding('tcp_wrap').TCP;

    if (arguments.length === 0 || typeof arguments[0] === 'function') {
        // Bind to a random port.
        listen(self, '0.0.0.0', 0, backlog);
    } else if (arguments[0] && typeof arguments[0] === 'object') {
        // Various descriptors are not supported by cluster workers.
        var h = arguments[0];
        if (h._handle) {
            h = h._handle;
        } else if (h.handle) {
            h = h.handle;
        }
        if (h instanceof TCP) {
            throw new Error('Can\'t listen on a TCP handle in cluster mode');
        } else if (typeof h.fd === 'number' && h.fd >= 0) {
            throw new Error('Can\'t listen on a file descriptor in cluster mode');
        } else {
            throw new Error('Invalid listen argument: ' + h);
        }
    } else if (isPipeName(arguments[0])) {
        // UNIX socket or Windows pipe.
        var pipeName = self._pipeName = arguments[0];
        // Since servers are addressed by port, we use the pipe name as the
        // port as well as the address.
        listen(self, pipeName, pipeName, backlog);
    } else if (
        typeof arguments[1] === 'undefined' ||
        typeof arguments[1] === 'function' ||
        typeof arguments[1] === 'number'
    ) {
        // The first argument is the port, no IP given.
        listen(self, '0.0.0.0', port, backlog);

    } else {
        throw new Error('Can\'t listen on an interface:port in cluster mode');
    }
    return self;
};

// This performs the actual listen when the argument forms have been
// normalized above.
function listen(self, address, port, backlog) {
    servers[port] = self;
    process.send({
        cmd: 'CLUSTER_LISTEN',
        port: port,
        address: address, // For confirmation purposes only.
        backlog: backlog
        // We allow the supervisor to infer the address type.
    });
}

// We receive an address property from the cluster supervisor when it confirms
// that we are listening on the requested interface.
Server.prototype.address = function () {
    return this._address;
};

function toNumber(x) { return (x = Number(x)) >= 0 ? x : false; }

function isString(s) { return typeof s === 'string'; }

function isPipeName(s) {
  return isString(s) && toNumber(s) === false;
}

function isFunction(f) { return typeof f === 'function'; }

