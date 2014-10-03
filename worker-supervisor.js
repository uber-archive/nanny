'use strict';

// A worker supervisor is an object that ensures that a worker process remains
// running, restarting the child process if necessary, and forwarding requests
// for network connections to the appropriate load balancer.

var events = require('events');
var childProcess = require('child_process');
var path = require('path');
var util = require('util');

function WorkerSupervisor(spec) {
    if (!(this instanceof WorkerSupervisor)) {
        return new WorkerSupervisor(spec);
    }
    this.logger = spec.logger;
    this.id = spec.id;
    this.spec = spec;
    this.createEnvironment = spec.createEnvironment || this.createEnvironment;
    this.checkHealth = spec.checkHealth || this.checkHealth;

    this.process = null;
    this.loadBalancers = {};

    this.health = null;

    // Pre-bind event handlers
    this.state = new Standby(this);

    this.handleError = this.handleError.bind(this);
    this.handleExit = this.handleExit.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
}

util.inherits(WorkerSupervisor, events.EventEmitter);

// Advances the worker's state due to a command or message from the child
// process itself.
// The `do` method of a state returns the next state, even if that state does
// not change.
// Every state must handle every command.
WorkerSupervisor.prototype.do = function (command, arg) {
    var former = this.state;
    this.state = former.do(command, arg);
    if (this.state !== former) {
        this.logger.debug('worker state change', this.inspect());
        this.emit(this.state.name, this);
    }
};

// This commands the worker to start up
WorkerSupervisor.prototype.start = function () { this.do('start'); };

// This commands the worker to stop, preferably with grace, but forcibly if
// necessary.
WorkerSupervisor.prototype.stop = function () { this.do('stop'); };

// This commands the worker to stop and start anew.
WorkerSupervisor.prototype.restart = function () { this.do('restart'); };

// This commands the worker to reload its configuration files, or restart.
WorkerSupervisor.prototype.reload = function () { this.do('reload'); };

// This commands the supervisor to terminate the worker without notice.
WorkerSupervisor.prototype.forceStop = function () { this.do('forceStop'); };

// This commands the worker to dump core immediately
WorkerSupervisor.prototype.dump = function () { this.do('dump'); };

// This commands the worker to drop to its debugger repl
WorkerSupervisor.prototype.debug = function () { this.do('debug'); };

// Inquires for the current state of the worker.
WorkerSupervisor.prototype.inspect = function () { return this.state.inspect(); };

// Thus ends the public interface of a worker supervisor.
// Thus begins the interface exposed for load balancers.

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
    if (!(error instanceof Error)) {
        throw new Error('Can\'t send error to worker. Must be an Error instance. Got: ' + error);
    }
    this.process.send({
        cmd: 'CLUSTER_ERROR',
        port: port,
        message: error.message
    });
};

// The worker supervisor tracks the load balancers for which it is listening
// and provides a public interface for managing this data, but the cluster
// supervisor is responsible for coordinating the linkage between worker
// supervisors and load balancers in response to events from both.

WorkerSupervisor.prototype.addLoadBalancer = function (loadBalancer) {
    this.loadBalancers[loadBalancer.port] = loadBalancer;
};

WorkerSupervisor.prototype.removeLoadBalancer = function (loadBalancer) {
    delete this.loadBalancers[loadBalancer.port];
};

WorkerSupervisor.prototype.forEachLoadBalancer = function (callback, thisp) {
    Object.keys(this.loadBalancers).forEach(function (port) {
        var loadBalancer = this.loadBalancers[port];
        callback.call(thisp, loadBalancer, port, this);
    }, this);
};

// Thus begins the internals.

WorkerSupervisor.prototype.createEnvironment = function () {
    return {
        PROCESS_LOGICAL_ID: this.id
    };
};

// Internal method for starting the worker subprocess, initiated by a state.
WorkerSupervisor.prototype.spawn = function () {
    var child = this.process;
    if (child) {
        throw new Error('Can\'t start with an existing child process');
    }

    var spec = this.spec;

    // TODO inject --abort_on_uncaught_exception to instruct V8 to dump core if
    // it hits an uncaught exception.
    var workerArgs = spec.args || [];
    var workerEnv = this.createEnvironment();
    var workerOptions = {
        cwd: spec.cwd,
        env: workerEnv,
        encoding: spec.encoding,
        execPath: spec.execPath,
        execArgv: spec.execArgv,
        silent: spec.silent,
    };
    var worker = childProcess.fork(path.join(__dirname, '_worker'), workerArgs, workerOptions);
    this.process = worker;

    // Issue a command to the thunk process requesting that it load the worker
    // module.
    worker.send({
        cmd: 'CLUSTER_START',
        modulePath: spec.workerPath,
        pulse: spec.pulse
    });

    worker.on('error', this.handleError);
    worker.on('exit', this.handleExit);
    worker.on('message', this.handleMessage);
};

// Internal method for sending a signal to a subprocess.
WorkerSupervisor.prototype.kill = function (signal) {
    var child = this.process;
    if (!child) {
        throw new Error('Assertion failed: can\'t stop without an attached child process');
    }
    try {
        child.kill(signal);
    } catch (error) {
        // kill throws an error if the child does not exist. Signal 0 is a
        // noop, but can be used to check for the existence of a process by forcing
        // this exception.
        // Regardless of the cause for this exception, the worker should be
        // notified that it is down so it can respond.
        if (signal !== 0) {
            this.logger.error('worker missing when sent signal', {
                id: this.id,
                signal: child.pid
            });
        }
        this.do('handleStop', {signal: signal});
    }
};

// Internal method, called by a state when a child process is confirmed dead.
WorkerSupervisor.prototype.fullStop = function () {
    this.process = null;
    this.emit('stop', this);
};

// Internal method, called if a child process emits an error.
WorkerSupervisor.prototype.handleError = function (error) {
    this.logger.debug('worker error', {
        id: this.id,
        error: error
    });
    this.do('handleStop', {error: error});
};

// Internal method, called if a child process emits an exit event.
WorkerSupervisor.prototype.handleExit = function (code, signal) {
    if (signal) {
        this.logger.debug('worker exited due to signal', {
            id: this.id,
            pid: this.process.pid,
            code: code,
            signal: signal
        });
    } else if (code !== 0) {
        this.logger.debug('worker exited with error', {
            id: this.id,
            pid: this.process.pid,
            code: code
        });
    } else {
        this.logger.debug('worker exited gracefully', {
            id: this.id,
            pid: this.process.pid,
            code: code
        });
    }
    this.do('handleStop', {code: code, signal: signal});
};

// Internal method, called if a child process sends a message on its IPC channel.
// This is how we communicate with the networking thunk in _worker.js.
WorkerSupervisor.prototype.handleMessage = function (message, handle) {
    // TODO This produces a lot of noise. Perhaps we need another log name.
    //this.logger.debug('spawned worker got message', {
    //    id: this.id,
    //    message: message
    //});
    if (typeof message !== 'object' || message === null) {
        return;
    }
    if (message.cmd === 'CLUSTER_LISTEN') {
        this.emit('listen', message.port, message.address, message.backlog, this);
    } else if (message.cmd === 'CLUSTER_CLOSE') {
        this.emit('close', message.port, this);
    } else if (message.cmd === 'CLUSTER_PULSE') {
        this.handlePulse(message);
    } else if (message.cmd === 'CLUSTER_RETURN_ERROR') {
        this.logger.debug('worker server closed before it could receive error', {
            id: this.id,
            port: this.port,
            message: message
        });
    } else if (message.cmd === 'CLUSTER_NOT_LISTENING') {
        this.logger.debug('worker server closed before it could receive confirmation that it is listening', {
            id: this.id,
            port: this.port
        });
    } else if (message.cmd === 'CLUSTER_BOUNCE') {
        this.logger.debug('worker server closed before it could accept a connection - redistributing', {
            id: this.id,
            port: this.port
        });
        // Inform the cluster supervisor that this connection bounced so it can
        // be returned to distribution.
        this.emit('bounce', message.port, handle, this);
    } else {
        this.logger.debug('spawned worker got message', {
            id: this.id,
            message: message
        });
    }
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

WorkerSupervisor.prototype.handlePulse = function (message) {
    // TODO make use of event loop load and memory usage information to
    // prioritize workers in scheduling
    this.health = {
        reportedAt: Date.now(),
        load: message.load,
        memoryUsage: message.memoryUsage
    };
    this.state.handlePulse();
    this.emit('health', this.health);
    if (!this.checkHealth(this.health)) {
        this.restart();
    }
};

WorkerSupervisor.prototype.checkHealth = function () {
    return true;
};

module.exports = WorkerSupervisor;


// ## States

// Thus ends the particulars of the worker supervisor and begins the parade of
// states.
// The worker supervisor delegates certain commands and messages to the current
// state object, and each command or message may result in a state change.
// The `do` method of each state returns the next state, albeit itself.


// ### Standing-by state

// In the stand by state, there is no child process and no communication from a
// child process is expected.
// During standby, batch stop and debug commands are ignored.
// When entering the standby state, you have the option of requesting a delayed
// restart.

function Standby(worker) {
    this.worker = worker;
    this.startDelayHandle = null;
    this.startingAt = null;
}

Standby.prototype.name = 'standby';

Standby.prototype.inspect = function () {
    return {
        id: this.worker.id,
        state: 'standby',
        startingAt: this.startingAt
    };
};

Standby.prototype.do = function (command, arg) {
    if (command === 'start' || command === 'reload') {
        this.cancelRestart();
        this.worker.spawn();
        return new Running(this.worker);
    } else if (command === 'restart') {
        this.scheduleRestart();
        return this;
    } else if (
        command === 'stop' || command === 'forceStop' ||
        command === 'dump' || command === 'debug'
    ) {
        this.cancelRestart();
        return this;
    } else {
        // The entire command vocabulary should be implemented.
        throw new Error(
            'Assertion failed: Can\'t ' + command + ' ' +
            JSON.stringify(arg) + ' while standing by on worker ' +
            this.worker.id
        );
    }
};

// This is called when a worker stops unexpectedly to set up the restart delay
// or ignore if restartCount is down.
Standby.prototype.scheduleRestart = function () {
    var restartDelay; // An undefined restart delay implies remain in stand by indefinitely
    var worker = this.worker;
    var spec = worker.spec;
    var logger = worker.logger;

    if (spec.respawnCount !== 0)  { // -1 and Infinity both imply indefinite restarts
        if (spec.respawnCount > 0) { // > 0 implies finite restarts
            this.worker.respawnCount--;
        }
        restartDelay = spec.restartDelay || 0;
    }

    if (restartDelay) {
        this.startingAt = Date.now() + restartDelay;
        logger.info('delaying worker restart', {
            id: worker.id,
            startingAt: this.startingAt
        });
        setTimeout(function () {
            logger.info('restarting worker now', {
                id: worker.id
            });
            worker.start();
        }, restartDelay);
    }
};

Standby.prototype.cancelRestart = function () {
    if (this.startDelayHandle) {
        clearTimeout(this.startDelayHandle);
        this.startDelayHandle = null;
    }
};


// ### Running state

function Running(worker, isDebugging) {
    this.worker = worker;
    this.isDebugging = isDebugging;
    this.at = Date.now();
    this.unhealthyTimeoutHandle = null;

    this.handleUnhealthyTimeout = this.handleUnhealthyTimeout.bind(this);

    // Start the health check interval if configured
    if (worker.spec.pulse && worker.spec.unhealthyTimeout) {
        this.scheduleUnhealthyTimeout();
    }
}

Running.prototype.name = 'running';

Running.prototype.inspect = function () {
    return {
        id: this.worker.id,
        state: 'running',
        pid: this.worker.process.pid,
        uptime: Date.now() - this.at,
        health: this.worker.health
    };
};

Running.prototype.do = function (command) {
    // Invariant: must call clearUnhealthyTimeout before transitioning into
    // another state.
    if (command === 'start') {
        // Already started. Idempotent.
        return this;
    } else if (command === 'stop') {
        this.worker.kill('SIGTERM');
        this.clearUnhealthyTimeout();
        return new Stopping(this.worker);
    } else if (command === 'forceStop') {
        this.worker.kill('SIGKILL');
        this.clearUnhealthyTimeout();
        return new Stopping(this.worker);
    } else if (command === 'dump') {
        this.worker.kill('SIGQUIT');
        // More patience needed for core dumps
        // TODO consider alternately spinning the worker off and producing a
        // new one to prevent blocking a new worker creation.
        // This may be necessary for preventing denial of service.
        this.clearUnhealthyTimeout();
        return new Stopping(this.worker, Infinity);
    } else if (command === 'restart') {
        return this.do('stop').do('restart');
    } else if (command === 'reload') {
        this.worker.kill('SIGHUP');
        return this;
    } else if (command === 'debug') {
        this.worker.kill('SIGUSR1');
        return this;
    } else if (command === 'handleStop') {
        // This path can be reached from SIGHUP, an error on spinning up the
        // child process, or a plain old crash.
        this.worker.fullStop();
        this.clearUnhealthyTimeout();
        return new Standby(this.worker).do('restart');
    } else {
        // The entire command vocabulary should be implemented.
        throw new Error('Assertion failed: can\'t ' + command + ' while running');
    }
};

Running.prototype.scheduleUnhealthyTimeout = function () {
    var worker = this.worker;
    this.unhealthyTimeoutHandle = setTimeout(
        this.handleUnhealthyTimeout,
        worker.spec.pulse + worker.spec.unhealthyTimeout
    );
};

Running.prototype.handleUnhealthyTimeout = function () {
    this.worker.logger.error('stopping spinning worker', {
        id: this.worker.id,
        pid: this.worker.process.pid
    });
    this.worker.restart();
};

Running.prototype.clearUnhealthyTimeout = function () {
    if (this.unhealthyTimeoutHandle) {
        clearTimeout(this.unhealthyTimeoutHandle);
    }
};

Running.prototype.handlePulse = function () {
    this.clearUnhealthyTimeout();
    this.scheduleUnhealthyTimeout();
};


// ### Stopping state

function Stopping(worker, forceStopDelay) {
    var spec = worker.spec;
    var logger = worker.logger;
    this.worker = worker;
    this.start = false;
    this.restart = false;
    this.at = Date.now();
    this.forceStopHandle = null;
    this.forceStopDelay = forceStopDelay || spec.forceStopDelay;

    // The force stop delay does get overridden to Inifinity in some cases.
    forceStopDelay = forceStopDelay || spec.forceStopDelay || 5000;
    // Schedule a forceful shutdown if graceful shutdown does not complete in a
    // timely fashion.
    logger.debug('worker force stop timeout scheduled', {
        id: worker.id,
        forceStopDelay: this.forceStopDelay
    });
    if (forceStopDelay < Infinity) {
        this.forceStopHandle = setTimeout(
            this.handleForceStopTimeout.bind(this),
            forceStopDelay
        );
    }
}

Stopping.prototype.name = 'stopping';

Stopping.prototype.inspect = function () {
    return {
        id: this.worker.id,
        state: 'stopping',
        pid: this.worker.process.pid,
        time: Date.now() - this.at,
        health: this.worker.health
    };
};

Stopping.prototype.do = function (command) {
    if (command === 'start' || command === 'reload') {
        // We will remain in the stopping state until the child process is
        // verifiably dead.
        // Instead of starting a new child process immediately, we make a note
        // to do so then.
        this.start = true;
        return this;
    } else if (command === 'restart') {
        // Restart differs only slightly. We will still wait for the stop.
        // We will follow up with a restart command instead of a start command,
        // which entrains the maximum number of automatic restarts limit and
        // the automatic restart delay if configured.
        this.restart = true;
        return this;
    } else if (command === 'stop') {
        // Idempotent.
        // Cancels a restart if this worker was asked to start, restart, or
        // reload while it was stopping.
        this.restart = false;
        return this;
    } else if (command === 'forceStop') {
        // A force kill cancels the current force-stop timer (if it still
        // exists), and proceeds to a new stopping state that resets the timer.
        this.worker.kill('SIGKILL');
        return this.followup(new Stopping(this.worker));
    } else if (command === 'dump') {
        // A forced core dump cancels the force-stop timer as well, proceeding
        // to a new stopping state with a new forced shutdown timer.
        this.worker.kill('SIGQUIT');
        return this.followup(new Stopping(this.worker));
    } else if (command === 'debug') {
        // Dropping to debug console returns us to the running state and
        // cancels the force shutdown.
        this.worker.kill('SIGUSR1');
        return this.followup(new Running(this.worker, !!'debug'));
    } else if (command === 'handleStop') {
        this.worker.fullStop();
        return this.followup(new Standby(this.worker));
    } else {
        throw new Error('Assertion failed: Can\'t ' + command + ' while stopping');
    }
};

// When we transition from stopping to standby, we clean up and apply any
// scheduled state stransitions.
// Particularly, we cancel the forced-stop timer, and restart if that is
// running is the target state.
Stopping.prototype.followup = function (state) {
    if (this.forceStopHandle) {
        clearTimeout(this.forceStopHandle);
    }
    if (this.start) {
        state = state.do('start');
    } else if (this.restart) {
        state = state.do('restart');
    }
    return state;
};

Stopping.prototype.handleForceStopTimeout = function () {
    var worker = this.worker;
    var logger = worker.logger;
    this.forceStopHandle = null;
    if (typeof this.forceStopDelay === 'number') {
        logger.debug('lost patience with stopping worker - forcing shutdown', {});
        worker.do('forceStop');
    } else {
        logger.debug('worker will not be forced to shut down - workerForceStopDelay not configured', {
            id: worker.id
        });
    }
};

Stopping.prototype.handlePulse = function () {
    // The pulse is ignored until the process stopped.
    // In the standby state, pulses are unexpected and would throw a
    // non-existing method error.
};

