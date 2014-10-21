'use strict';

/* TODO the supervisor and client should agree on an identifier for every
 * server so connections and errors go to the correct instance. */
/* TODO graceful shutdown on uncaught exception, exit, etc */

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

// Invariant: we must close a server before emitting an error.

var net = require('net');
var events = require('events');
var util = require('util');

var servers = {}; // Indexed by port.
// These are mutually recursive and JSHint likes them declared before use:
var tickTime, pulse;

// ## Communication with the supervisor

process.on('message', function (message, handle) {
    if (typeof message !== 'object' || message === null) {
        return;
    }
    if (message.cmd === 'CLUSTER_START') {
        handleStart(message.modulePath, message.pulse);
    } else if (message.cmd === 'CLUSTER_ACCEPT') {
        handleAccept(message.port, handle);
    } else if (message.cmd === 'CLUSTER_LISTENING') {
        handleListening(message.port, message.address);
    } else if (message.cmd === 'CLUSTER_ERROR') {
        handleError(message.port, message.message);
    }
});

// The supervisor will immediately send a request to start running a worker
// module and kick off the configured heart beat.
var started = false;
function handleStart(modulePath, givenPulse) {

    if (started) {
        throw new Error('Assertion failed: worker received a second start message over its IPC channel');
    }
    started = true;

    // Start periodic health reports.
    pulse = givenPulse;
    if (pulse) {
        tick();
    }

    // Leave no evidence. - Invader Zim
    process.argv[1] = modulePath;

    // Start running the worker module.
    require(modulePath);
}

function handleAccept(port, handle) {
    var server = servers[port];
    if (!handle) {
        // We hit this case only when we receive a connection message from the cluster,
        // but the cluster is shutting down.
        return;
    }
    if (server) {
        server._accept(handle);
    } else {
        // Return to sender if the server no longer exists.
        // This might occur if a connection was sent from the cluster to the
        // worker before the cluster received a notification from the worker
        // that it had closed the corresponding server.
        process.send({cmd: 'CLUSTER_BOUNCE', port: port}, handle);
    }
}

function handleListening(port, address) {
    var server = servers[port];
    if (server) {
        // The address that a server receives is not necessarily knowable
        // based on the address or port that it requested.
        // Specifically, if you request a server on port 0, this allows the
        // operating system to assign an emphemeral port.
        // When a server advertizes that it is now accepting connections,
        // it must also allow the user to call `address()` to discover what
        // port it is listening on.
        // We capture this address in the `_address` property in a worker's
        // Server thunk.
        // Node.js core implements `address()` very differently, but we
        // allow that work to occur on the cluster leader.
        server._address = address;
        server.emit('listening', server);
    } else {
        // If a server starts listening but closes before the cluster can
        // respond, we can assume that a CLUSTER_CLOSE message has already
        // been sent to the to the supervisor and that the server will be
        // duly removed from the load balancer rotation.
        // There is nothing to do in the worker to respond to this
        // situation, but we will inform the cluster for logging purposes.
        process.send({
            cmd: 'CLUSTER_NOT_LISTENING', // Gollum.
            port: port
        });
    }
}

function handleError(port, message) {
    var server = servers[port];
    if (server) {
        // Close before calling out to user code.
        server.close();
        // Note that the following will throw synchronously if there are no
        // error handlers or if any of those handlers throw.
        server.emit('error', new Error(message));
    } else {
        process.send({
            cmd: 'CLUSTER_RETURN_ERROR',
            port: port,
            message: message
        });
    }
}

// ## Heart beat health check

// Here follows the mechanism for periodically sending health checks to the
// supervisor over the Node.js IPC channel.

// Marks the start time and schedules the next pulse.
function tick() {
    tickTime = process.hrtime();
    setTimeout(tock, pulse);
}

// Measures the actual duration of the pulse and transmits health metrics to
// the supervisor.
// The load measures the average amount of time that the event loop blocked the
// scheduled pulse.
function tock() {
    var tockPeriod = process.hrtime(tickTime);
    var tockPeriodMs = hrtimeAsMs(tockPeriod);
    process.send({
        cmd: 'CLUSTER_PULSE',
        load: tockPeriodMs - pulse,
        memoryUsage: process.memoryUsage()
    });
    tick();
}

// `hrtime` returns a [seconds, nanoseconds] tuple.
function hrtimeAsMs(duple) {
    var seconds = duple[0];
    var nanoseconds = duple[1];
    return seconds * 1e3 + nanoseconds / 1e6;
}

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

    if (typeof arguments[0] === 'function') {
        options = {};
        self.on('connection', arguments[0]);
    } else {
        options = arguments[0] || {};
        if (typeof arguments[1] === 'function') {
            self.on('connection', arguments[1]);
        }
    }

    this._connections = [];

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
    var pipeName;

    // The third optional argument is the backlog size.
    // When the ip is omitted it can be the second argument.
    var backlog = toNumber(arguments[1]) || toNumber(arguments[2]);

    var TCP = process.binding('tcp_wrap').TCP;

    if (arguments.length === 0 || typeof arguments[0] === 'function') {
        // Bind to a random port.
        listen(self, null, 0, null, backlog);
    } else if (arguments[0] && typeof arguments[0] === 'object') {
        // Various descriptors are not supported by cluster workers.
        var h = arguments[0];
        h = h._handle || h.handle || h;
        if (h instanceof TCP) {
            throw new Error('Can\'t listen on a TCP handle in cluster mode yet');
        } else if (typeof h.fd === 'number' && h.fd >= 0) {
            throw new Error('Can\'t listen on a file descriptor in cluster mode yet');
        } else {
            // The first argument is a configuration object
            if (h.backlog)
                backlog = h.backlog;

            if (typeof h.port === 'number') {
                if (h.host) {
                    listenAfterLookup(h.port, h.host, backlog, h.exclusive);
                } else {
                    listen(self, null, h.port, 4, backlog, undefined, h.exclusive);
                }
            } else if (h.path && isPipeName(h.path)) {
                pipeName = self._pipeName = h.path;
                listen(self, pipeName, -1, -1, backlog, undefined, h.exclusive);
            } else {
                throw new Error('Invalid listen argument: ' + h);
            }
        }
    } else if (isPipeName(arguments[0])) {
        // UNIX socket or Windows pipe.
        pipeName = self._pipeName = arguments[0];
        // Since servers are addressed by port, we use the pipe name as the
        // port as well as the address.
        listen(self, pipeName, pipeName, undefined, backlog);
    } else if (
        typeof arguments[1] === 'undefined' ||
        typeof arguments[1] === 'function' ||
        typeof arguments[1] === 'number' ||
        arguments[1] === null
        // The null case does not exist in Node.js. However, for some reason,
        // listen(port, address, backlog) where any argument may be null does
        // work on Node.js. Since the RR load balancer uses this pattern, this
        // condition is necessary to self host, as verified by running
        // test/rock-and-hard-place.js.
    ) {
        // The first argument is the port, no IP given.
        listen(self, null, port, 4, backlog);

    } else {
        // The first argument is the port, the second an IP.
        listenAfterLookup(port, arguments[1], backlog);
    }

    function listenAfterLookup(port, address/*, backlog, exclusive*/) {
        /* TODO We need to reason out whether the worker or cluster will issue the DNS request. */
        throw new Error('Can\'t listen on an interface and port in cluster mode yet: ' + address + ':' + port);
        /*
        require('dns').lookup(address, function(err, ip, addressType) {
            if (err) {
                self.emit('error', err);
            } else {
                addressType = ip ? addressType : 4;
                listen(self, ip, port, addressType, backlog, undefined, exclusive);
            }
        });
        */
    }

    return self;
};

// This performs the actual listen when the argument forms have been
// normalized above.
/*jshint -W072 */
function listen(self, address, port, addressType, backlog, exclusive) {
    /* TODO Index servers by a self-assigned identifier and the process
     * identifier so messages intended for previous instances do not pass
     * through. */
    servers[port] = self; // Index servers by port.
    self._port = port; // Remember the requested port for close.
    process.send({
        cmd: 'CLUSTER_LISTEN',
        port: port,
        address: address, // For confirmation purposes only.
        addressType: addressType, // We allow the supervisor to infer the address type.
        backlog: backlog, // Used to confirm uniformity of worker requests.
        exclusive: exclusive // TODO use this on the other end
    });
}
/*jshint +W072 */

Server.prototype.close = function (callback) {
    if (callback) {
        this.once('close', callback);
    }
    process.send({
        cmd: 'CLUSTER_CLOSE',
        port: this._port
    });
    // This prevents any further connections from falling into this server
    // instance.
    delete servers[this._port];
    var self = this;
    /* TODO emit 'close' event only when all open connections are closed. */
    process.nextTick(function () {
        self.emit('close');
    });
};

Server.prototype._accept = function (connection) {
    var self = this;
    function onfinish() {
        var index = self._connections.indexOf(connection);
        if (index >= 0) {
            self._connections.splice(index, 1);
        }
    }
    connection.once('finish', onfinish);
    this._connections.push(connection);
    this.emit('connection', connection);
};

Server.prototype.getConnections = function (cb) {
    function end(err, connections) {
        process.nextTick(function () {
            cb(null, connections);
        });
    }

    end(null, this._connections);
};

// There is not much we can do about ref and unref. The underlying handle is on
// the cluster and will be retained indefinitely.
// The IPC channel retains this process.

Server.prototype.unref = function () { };

Server.prototype.ref = function () { };

// We receive an address property from the cluster supervisor when it confirms
// that we are listening on the requested interface.
// This works for both the socket and pipe cases since the address() method
// returns either a pipe name string or a host port pair.
Server.prototype.address = function () {
    return this._address;
};

function toNumber(x) { return (x = Number(x)) >= 0 ? x : false; }

function isPipeName(s) {
  return typeof s === 'string' && toNumber(s) === false;
}

