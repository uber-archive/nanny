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
        this.emit('transition', this.state.name, former.name, this);
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
    // TODO handle aberrant cases where error is not actually an Error object.
    this.process.send({
        cmd: 'CLUSTER_ERROR',
        port: port,
        message: error.message
    });
};

// Thus begins the internals.

// Internal method for starting the worker subprocess, initiated by a state.
WorkerSupervisor.prototype.spawn = function () {
    var child = this.process;
    if (child) {
        throw new Error('Can\'t start with an existing child process');
    }

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

    // Issue a command to the thunk process requesting that it load the worker
    // module.
    worker.send({cmd: 'CLUSTER_START', modulePath: workerPath, pulse: workerPulse});

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
        this.do('handleStop');
    }
};

// Internal method, called by a state when a child process is confirmed dead.
WorkerSupervisor.prototype.handleStop = function () {
    this.process = null;
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
WorkerSupervisor.prototype.handleMessage = function (message) {
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
    } else if (message.cmd === 'CLUSTER_RETURN_ERROR') {
        this.logger.debug('worker server closed before it could receive an error event from the cluster', {
            id: this.id,
            port: this.port
        });
    // TODO handle CLUSTER_REJECT if a connection was sent to the worker but
    // rejected. This should return the connection to the load balancer.
    //} else if (message.cmd === 'CLUSTER_REJECT') {
    // TODO handle CLUSTER_CLOSE when a worker closes a server and needs to be
    // removed from the load balancer rotation.
    //} else if (message.cmd === 'CLUSTER_CLOSE') {
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
        load: message.load,
        memory: message.memoryUsage
    };
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

function Standby(worker, startDelay) {
    this.worker = worker;
    this.startDelayHandle = null;
    this.startAt = null;
    if (startDelay !== void 0) {
        this.startAt = Date.now() + startDelay;
        setTimeout(function () {
            console.log("START");
            worker.start();
        }, startDelay);
    }
}

Standby.prototype.name = 'standby';

Standby.prototype.inspect = function () {
    return {state: 'standby', id: this.worker.id, timeToStart: this.startAt - Date.now()};
};

Standby.prototype.cancelStart = function () {
    if (this.startDelayHandle) {
        clearTimeout(this.startDelayHandle);
        this.startDelayHandle = null;
    }
};

Standby.prototype.do = function (command, arg) {
    if (command === 'start' || command === 'restart' || command === 'reload') {
        this.cancelStart();
        this.worker.spawn();
        return new Running(this.worker);
    } else if (command === 'stop' || command === 'forceStop') {
        this.cancelStart();
        return this;
    } else if (command === 'dump' || command === 'debug') {
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


// ### Running state

function Running(worker, isDebugging) {
    this.worker = worker;
    this.isDebugging = isDebugging;
}

Running.prototype.name = 'running';

Running.prototype.inspect = function () {
    return {state: 'running', id: this.worker.id, pid: this.worker.process.pid, health: this.worker.health};
};

Running.prototype.do = function (command) {
    if (command === 'start') {
        // Already started. Idempotent.
        return this;
    } else if (command === 'stop') {
        this.worker.kill('SIGTERM');
        return new Stopping(this.worker);
    } else if (command === 'forceStop') {
        this.worker.kill('SIGKILL');
        return new Stopping(this.worker);
    } else if (command === 'dump') {
        this.worker.kill('SIGQUIT');
        // More patience needed for core dumps
        // TODO consider alternately spinning the worker off and producing a
        // new one to prevent blocking a new worker.
        // This may be necessary for preventing denial of service.
        return new Stopping(this.worker, Infinity);
    } else if (command === 'restart') {
        return this.do('stop').do('start');
    } else if (command === 'reload') {
        this.worker.kill('SIGHUP');
        return this;
    } else if (command === 'debug') {
        this.worker.kill('SIGUSR1');
        return this;
    } else if (command === 'handleStop') {
        // This path can be reached from SIGHUP, an error on spinning up the
        // child process, or a plain old crash.
        this.worker.handleStop();
        var restartDelay; // An undefined restart delay implies remain in stand by indefinitely
        if (this.worker.respawnCount !== 0)  { // -1 and Infinity both imply indefinite restarts
            if (this.worker.respawnCount > 0) { // > 0 implies finite restarts
                this.worker.respawnCount--;
            }
            restartDelay = this.worker.supervisor.autoRestartDelay || 0;
        }
        return new Standby(this.worker, restartDelay);
    } else {
        // The entire command vocabulary should be implemented.
        throw new Error('Assertion failed: can\'t ' + command + ' while running');
    }
};


// ### Stopping state

function Stopping(worker, patience) {
    var self = this;
    this.worker = worker;
    this.restart = false;
    this.forcefulStopHandle = null;

    patience = patience || worker.supervisor.patience;

    if (patience) {
        // Schedule a forceful shutdown if graceful shutdown does not complete in a
        // timely fashion.
        this.forcefulStopHandle = setTimeout(function () {
            self.forcefulStopHandle = null;
            worker.logger.debug('lost patience with stopping worker - forcing shutdown');
            worker.do('forceStop');
        }, patience);
    }
}

Stopping.prototype.name = 'stopping';

// When we transition from stopping to standby, we clean up and apply any
// scheduled state stransitions.
// Particularly, we cancel the forced-stop timer, and restart if that is
// running is the target state.
Stopping.prototype.followup = function (state) {
    if (this.forcefulStopHandle) {
        clearTimeout(this.forcefulStopHandle);
    }
    if (this.restart) {
        state = state.do('start');
    }
    return state;
};

Stopping.prototype.inspect = function () {
    return {state: 'stopping', id: this.worker.id, pid: this.worker.process.pid};
};

Stopping.prototype.do = function (command) {
    if (command === 'start' || command === 'restart' || command === 'reload') {
        // We will remain in the stopping state until the child process is
        // verifiably dead.
        // Instead of starting a new child process immediately, we make a note
        // to do so then.
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
        this.worker.handleStop();
        return this.followup(new Standby(this.worker));
    } else {
        throw new Error('Assertion failed: Can\'t ' + command + ' while stopping');
    }
};

