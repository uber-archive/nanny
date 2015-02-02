
# Nanny

In some sense, a nanny watches kids.
This module provides a cluster supervisor.
A cluster is a group of worker processes that share a server or servers.
The cluster supervisor:

-   maintains a pool of workers,
-   monitors the health of the workers including event loop responsiveness and
    memory consumption,
-   restarts workers if they stop,
-   stops workers if they fail a health check,
-   distributes incoming connections to the cluster workers

The cluster supervisor manages workers and load balancers.
This package provides a round robin load balancer.
Each connection will go to the least recently connected worker.

Worker processes do not require any special programming to participate in a
cluster.
The worker will be loaded in proxy by a “thunk” worker that will establish
communication with the cluster supervisor, subvert Node.js's networking stack,
and execute the worker module.
Any attempt to listen for incomming connections with a `net`, `http`, or
`https` server will be intercepted and managed by the cluster.

## Example

```js
// launcher.js
var path = require('path');
var ClusterSupervisor = require("nanny");
var supervisor = new ClusterSupervisor({
    workerPath: path.join(__dirname, "server.js"),
});
process.title = 'nodejs my-supervisor';
supervisor.start();
```

```js
// server.js
process.title = 'nodejs my-worker';
// initialize worker stuff here...
```


## Docs

Nanny exports a `ClusterSupervisor` function that accepts a spec object and
returns an instance.
The cluster supervisor constructor may be called with or without `new`.
The `workerPath` is the only required property of the spec.
All other properties are options.

Cluster supervisors implement Node.js's `EventEmitter`.

The `ClusterSupervisor.prototype` also has `LoadBalancer` and
`WorkerSupervisor` constructors that can be overloaded by heirs.

### `clusterSpec.workerPath` **required**

The file system path of the Node.js executable that will run as the worker.
The worker script should be written as a normal Node.js program.
That is, there is no cluster module that the worker needs to load, nor does it
need to check whether it is running as a worker or supervisor.
The supervisor and worker scripts are separate.
Nanny will run a thunk module that will arrange for a seemingly unmodified
environment, except that the `net.Server` has been subverted and a periodic
health monitor ("pulse") has been set up.
`require.main` will be your worker `module` and `process.argv` will have
`workerPath` at index 1, just as they would if Node.js ran your worker
directly.

### `clusterSpec.workerArgv`

The command line arguments to pass to your worker script, as will appear at
index 2 and beyond of `process.argv` to your worker.

By default, this is empty.

### `clusterSpec.workerCount`

The number of workers to maintain.
Each worker will be assigned its 0-base index for its logical identifier.
The default worker count is the number of logical CPU's on the host machine
as reported by `process.cpus().length`.

The worker count is **optional** but cannot be provided if you instead provide
`logicalIds`.

### `clusterSpec.logicalIds`

An array of logical identifiers for each worker that the supervisor should
maintain.
The default logical identifiers start with 0 and are as many as the host
machine's CPUs.

The logical identifiers are **optional** but cannot be provided if you instead
explicate `workerCount`.

Logical identifiers may be numbers or strings.

### `clusterSpec.logger`

Overrides the default logger object for the cluster.
Nanny uses the methods `error`, `warn`, `info`, and `debug`, all of which must
accept the log string and an optional object containing additional contextual
information.
The `fatal` method might be used in a future version.

The default logger is provided by the [debuglog][] packaged module and all levels
are visible if you include `nanny` in the ``NODE_DEBUG`` space delimited
environment variable.

[debuglog]: https://www.npmjs.org/package/debuglog

```
NODE_DEBUG=nanny node supervisor.js
```

### `clusterSpec.createEnvironment(logicalId)`

The worker supervisor will call this method once before each time it spawns a
worker subprocess with the logical identifier of the worker as its first
argument and with the WorkerSupervisor instance as `this`.
The environment creator must return an object with the entire map of
environment variables that the worker will need.

The default environment creator returns an object with a ``PROCESS_LOGICAL_ID``
set to the worker's logical identifier.

Note that the returned environment is taken to be an **exhaustive**
environment, meaning that worker processes do not implicitly inherit the
supervisor process's environment.
To explicitly forward an environment, extent `process.env`

```js
var extend = require('xtend');
new Supervisor({
    createEnvironment: function (id) {
        return extend(process.env, {
            MY_TITLE: 'nodejs my-worker-' + id,
            MY_WORKER_ID: id
        });
    }
})
```

### `clusterSpec.pulse`

The interval at which workers will attempt to submit a health report, in
miliseconds.
By default, workers will not submit health reports.

At time of writing, the health monitor will keep a process alive unless it
calls `process.exit` explicitly.
In a future version, stopping a worker should shut down the health checks so it
can gracefully exit.

### `clusterSpec.isHealthy`

When a worker submits a health report, the supervisor calls this method to
check whether the process is healthy with that report.
The health report includes *self reported* memory usage and event loop metrics.

The following is a partial supervisor that will kill a worker if it reports
that it has allocated more than 100MB of memory, will check health every
second, will stop a worker if it fails to check in within 6 seconds (1 for
pulse, 5 for timeout).

```js
new Supervisor({
    isHealthy: function (report) {
        return report.memoryUsage.rss < 100e6
    },
    pulse: 1e3,
    unhealthyTimeout: 5e3
});
```

- `memoryUsage` as returned by Node.js's [process.memoryUsage][MEM]
    -   `rss` system memory usage in bytes
    -   `heapTotal` memory allocated by V8
    -   `heapUsed` memory in use from slabs alocated by V8
- `load` the number of miliseconds (in nanosecond resolution) that an enqueued
  task had to wait before it was executed.

[MEM]: http://nodejs.org/api/process.html#process_process_memoryusage

```ocaml
Health : {memoryUsage: MemoryUsage, load: Number}
MemoryUsage: {rss: Number, heapTotal: Number, heapUsed: Number}
```

This function is called as a method of the corresponding worker supervisor, so
for example, `this.id` is the corresponding worker logical id.

If `isHealthy` returns a falsy value, the worker will be stopped with the
intention to restart. The force stop delay, restart delay, and restart count
options apply in this case.

The default `isHealthy` method returns true regardless of the health report.

Note that this method will never be called, and thus unhealthy workers will not
be restarted, unless the supervisor is initialized with a `pulse`.

### `clusterSpec.unhealthyTimeout`

If this option is provided, the supervisor will automatically stop any worker
that fails to report its health in a timely fashion.
The unhealthy timeout is the number of miliseconds that the supervisor will
wait **after** the expected check-in time.
The force stop delay, restart delay, and restart count options apply in this
case.

### `clusterSpec.workerForceStopDelay`

Any worker that is stopped (including stops with the intent to restart) will be
killed with prejudice if it fails to exit gracefully before this timeout in
miliseconds.

The default delay is 5 seconds and can be overridden on heirs over
`ClusterSupervisor.prototype.defaultWorkerForceStopDelay`.

### `clusterSpec.workerRestartDelay`

If this option is provided, any worker that attempts to restart will be forced
to wait this number of miliseconds between stopping and starting.

### `clusterSpec.respawnWorkerCount`

If this option is provided, any time a worker is stopped with the intention to
restart (including both manual `restart()` calls and automatic restarts, but
not including manual `stop()` followed by `start()` calls), the worker will not
restart if this many restarts have been attempted for this worker, regardless
of whether the restarts were "successful".
The supervisor does not distinguish sucessful and failed starts.

### `clusterSpec.serverRestartDelay`

If this option is provided, the load balancer will wait this number of
miliseconds between when a supervisor server stops due to an error and when the
supervisor resumes listening on the corresponding port.

Note that this setting applies to the socket server running in the supervisor
process for a given port, not to a worker.

### `clusterSpec.execPath`
### `clusterSpec.execArgv`
### `clusterSpec.cwd`
### `clusterSpec.encoding`
### `clusterSpec.silent`

These options are passed through to Node.js's child process [fork][].
Particularly, `execArgv` is distinct from `workerArgv`. The `execArgv` are
options for Node.js and are not visible to the worker.
These are useful for V8 and Node.js options.

[fork]: http://nodejs.org/api/child_process.html#child_process_child_process_fork_modulepath_args_options

A snapshot of these options are captured on each worker supervisor instance's
`spec` property and are queried each time the supervisor spawns a new worker,
so it is possible to manipulate these values, per worker, before each restart.

### Cluster supervisor methods

The following documentation pertains to the methods of a cluster supervisor, as
returned by the `ClusterSupervisor(clusterSpec)` function.

### `clusterSupervisor.start()`

Sets the target state of each worker to "running" and initiates the sequence of
operations necessary to get to that state from each worker's current state.

:warning: At time of writing, this method should only be called once.
In the future it should be possible to restart a supervisor, and the start
method should be idempotent.

### `clusterSupervisor.stop()`

Sets the target state of each worker to "standby" and initiates the sequence of
operations necessary to get to that state form each worker's current state.

:warning: At time of writing, a stopped cluster cannot be restarted.
Individual workers can be restarted many times within the lifespan of the
cluster supervisor.

### `clusterSupervisor.inspect()`

Returns an object representing a snapshot of the system state of the entire
supervisor.

The root object contains properties `workers` and `loadBalancers`, which are
each arrays of the respective state of each worker and load balancer.
Workers correspond to worker supervisors.
Load balancers correspond to ports managed by the cluster supervisor.

```ocaml
ClusterState : {workers: Array<WorkerState>, loadBalancers: Array<LoadBalancerState>}
```

See the documentation for worker supervisors and load balancers for their
respective state representations as returned by their own `inspect()` methods.

### `clusterSupervisor.countWorkers()`

Returns the number of allocated workers.

### `clusterSupervisor.countRunningWorkers()`

Returns the number of workers that are currently running.

### `clusterSupervisor.countActiveWorkers()`

Returns the number of workers that are not on standby, running or on their way
to or from running.

### `clusterSupervisor.countRunningLoadBalancers()`

Returns the number of load balancers that are listening on a port and accepting
connections.

### `clusterSupervisor.countActiveLoadBalancers()`

Returns the number of load balancers that are not on standby: running or on
their way to or from running.

### `clusterSupervisor.forEachWorker(callback, thisp)`

Calls the callback once for every worker supervisor before returning.
The callback receives the worker supervisor, the logical identfier for that
supervisor, and the supervisor itself.

### `clusterSupervisor.forEachLoadBalancer(callback, thisp)`

Calls the callback once for every load balancer before returning.
The callback receives the load balancer, the port number, and the supervisor
itself.

### `WorkerSupervisor(workerSupervisorSpec)`

The cluster supervisor constructs and exposes worker supervisor instances.
Each of these supervisors has a state machine with "standby", "running", and
"stopping" states.
The supervisor reacts to events and commands based on its current state.
For example, the `start()` command on a running worker will do nothing,
but the `start()` command on a stopping worker will cause the worker to restart
immediately after it transitions to standby.

### `workerSupervisor.id`

The logical identifier assigned to this worker supervisor, one of the logical
identifiers constructed or provided to the cluster supervisor as `logicalIds`
or inferred from the number of processors.

### `workerSupervisor.inspect()`

Returns a JSON serializable representation of the worker's state.

Workers in the standby state have been stopped or not started.

- If they were stopped with the intent to restart, the `startingAt` indicates
  the intended time to start, or may be null.

Workers in the running state have been started and the subprocess may still be
coming up.

- The `pid` is the operating system's process identifier for the forked
  worker.
- The `startedAt` is the number representing when the child process was
  originally forked.

Workers in the stopping state include worker lifetime statistics, `startedAt`,
`stopRequestedAt`, and `forceStopAt`.

- The `stopRequestedAt` is the number representing when the child process was
  requested to stop or restart.
- The `forceStopedAt` is the number representing when the child process either
  should be or was force stopped.
- The `isDebugging` flag indicates that the process was not actually stopped,
  but that its [debugger][] was activated.
  It is the responsibility of the debugging user to manually stop the process.
  When a process is in the debug state, you can, for example, connect to the
  process with `node debug -p <pid>` for a debug console.
- The force stop time may have passed, in which case `forcedStop` will be true.
  A worker that has been given the `debug()` command will activate the V8
  [debugger][] and enter the "stopping" state without the intent to force stop.
- The worker state will include a health report snapshot if one has been
  received in either running or stopping states.

[debugger]: http://nodejs.org/api/debugger.html

```ocaml
WorkerState : WorkerStandbyState | WorkerRunningState | WorkerStoppingState

WorkerStandbyState : {
    id,
    state: "standby",
    startingAt: Number
}

WorkerRunningState : {
    id,
    state: "running",
    pid: Number,
    startedAt: Number,
    health?: Health
}

WorkerStoppingState : {
    id,
    state: "stopping",
    pid: Number,
    isDebugging: Boolean,
    startedAt: Number,
    stopRequestedAt: Number,
    forceStopAt: Number,
    forcedStop: Boolean,
    health?: Health
}
```

### `workerSupervisor.isHealthy(report)`

Returns whether the process is healthy (should not be stopped) based on its
self reported memory usage and load metrics.

By default this returns true, but can be overridden on the cluster supervisor
spec.

### Worker state machine commands

The following are commands that set the intended stable state of the worker and
initiate the operations necessary to get to that state.

### `workerSupervisor.start()`

- standby: Forks a worker process.
- running: Does nothing.
- stopping: Nodes an intent to start when the worker process stops.

### `workerSupervisor.stop()`

- standby: If there is a scheduled restart, cancels that timer.
- running: Send a SIGINT to the worker process and move to the stopping state.
- stopping: Do nothing.

### `workerSupervisor.restart()`

- standby: If the worker has not restarted more times than the configured
  maximum, schedules a a restart after the configured restart delay.
- running: Issues the stop and restart commands.
- stopping: Notes an intent to restart when the worker process stops.

### `workerSupervisor.reload()`

- standby: Does nothing.
- running: sends the SIGHUP signal to the worker process.
  This will either cause the process to stop voluntarily or reload its
  configuration.
- stopping: Notes an intent to restart when the worker process stops.

### `workerSupervisor.forceStop()`

- standby: If there is a scheduled restart, cancels that timer.
- running: Sends a SIGKILL signal to the worker process and goes to the
  stopping state.
- stopping: Sends a SIGKILL signal to the worker process.

### `workerSupervisor.debug()`

- standby: Does nothing.
- running: Enters the stopping state without intent to restart and reissues the
  debug command.
- stopping: Sends the worker process a SIGUSR1 signal (which turns on the V8
  [debugger][]), cancels the force stop timer, and waits.

### `workerSupervisor.dump()`

- standby: Does nothing.
- running: Sends the SIGABRT signal to the worker process and enters the
  stopping state.
- stopping: Sends the SIGABRT signal to the worker process.

### `LoadBalancer(loadBalancerSpec)`

The load balancer constructor accepts a spec with the following properties.

- `logger`
- `port`
- `address`
- `backlog`
- `restartDelay`

The load balancer is an event emitter. The cluster supervisor depends on the
following event.

- `standby` when it has stopped.

The load balancer implements the following methods.

- `inspect` which captures a snapshot of the load balancer state.
- `addWorkerSupervisor(worker)` which adds a worker supervisor to the queue of
  available workers accepting connections.
- `removeWorkerSupervisor(worker)` which removes a worker from the rotation of
  accepting workers.
- `handleConnection(connection)` which sends a connection to one of the
  workers, or buffers the connection until a worker becomes available.
- `stop()` which requests that the load balancer tear down its server.
  Load balancers are not restartable at time of writing, but can gracefully
  handle all workers coming and going ad nauseam.
  This method is only used for intentional teardown of the cluster for graceful
  process exit.

The cluster supervisor depends on the following properties of a load balancer.

- `requestedAddress`, from the speced address
- `requestedBacklog`, from the speced backlog

The following properties are for the load balancer implementation and your
information.

- `port`, the requested port.
- `address`, the *actual* address received from the operating system.
- `server`, the Node.js server listening on the supervisor.

### `loadBalancer.inspect()`

The load balancers can be in "standby", "starting", "running", and "stopped"
states surrounding the Node.js socket server state machine.
The load balancer will try to remaining "running" once it has been created,
until it is expressly stopped.

- Standby means that the load balancer does not have a socket server.
- Starting means that a server has been created and is waiting for confirmation
  that it is listening on the request port.
- Running means the load balancer has a server that is listening on the
  requested port.
  Only in this state will the cluster supervisor send connections to workers.
  Otherwise, connections will be queued.
- Stopping means the load balancer has closed its server and is waiting for
  confirmation of close.
- The `port` is the port that the load balancer was requested for.
  This port might be 0, in which case the corresponding actual port will
  differ.
- The `address` is the actual address granted by the operating system to the
  cluster supervisor process.
- The `backlog` is the requested number of connections to buffer by the first
  worker to request this port.
  This is often undefined.
  The [backlog][] is an infrequently recognized option of Node.js servers.

[backlog]: http://nodejs.org/api/net.html#net_server_listen_port_host_backlog_callback

```ocaml
LoadBalancerState : {
    state: "standby" | "starting" | "running" | "stopped",
    port: Number,
    address: Address,
    backlog: Number
}
```

## Cluster Supervisor Logs

All cluster supervisor logs include the process title as reflected by
`process.title`.

### INFO `initing master`

- title
- logicalIds: an array of the logical identifiers of all worker supervisors.

Reports that the cluster supervisor has been constructed and will be
initialized.
If you see more than one of these messages, the process is constructing too
many cluster supervisors.

### INFO `cluster now active`

- title

Indicates that all workers have been started.

### INFO `cluster now standing by`

- title

Indicates that all workers and load balancers have stopped.
This should only occur in response to a stop signal or a manual `stop()` call.

### INFO `cluster master received signal...killing workers`

- title
- signal: the signal that the supervisor received

### DEBUG `cluster checking for full stop`

- title
- activeWorkerCount
- activeLoadBalancerCount

When a load balancer or worker supervisor changes its state, the cluster
supervisor checks whether all of these have returned to standby, in which case
goes to standby itself.
This debug message shows the number of active workers and load balancers and
the supervisor should go to standby if these are both zero.


## Worker Supervisor Logs

### INFO `worker state change`

This message indicates that the worker has transitioned to a new state, one of
"standby", "running", or "stopping".
Regardless, the logger payload is the result of `workerSupervisor.inspect()`.

### ERROR `worker fork error`

- id
- error

This message indicates that the supervisor was unable to create a child process
for the worker with the given logical identifier.

### INFO `worker exited gracefully`

- id
- pid
- code, necessarily zero

### INFO `worker exited due to signal`

- id
- pid
- code
- signal

### ERROR `worker exited with error`

- id
- pid
- code

### INFO `worker post mortem`

Indicates that a worker has stopped and reports various lifecycle metrics.

- id
- pid
- code: exit status code
- signal?: signal name that caused exit if present
- error?: error if the worker could not be forked
- startedAt: date of start
- stopRequestedAt: date when the process was asked to stop
- stoppedAt: date when the process actually stopped
- forcedStop: whether it was necessary to send a kill signal to stop
- upTime: duration from startedAt to stoppedAt
- teardownTime: duration from stopRequestedAt to stoppedAt
- lastKnownHealth?: last health if ever reported

### WARN `worker supervisor received non-object message`

This indicates that the supervisor received a message from the worker processes
over the Node.js IPC channel, but that message was not a regular object.
The cluster supervisor has no code that would cause this, but it is possible
for specialized supervisors to piggy-back on the IPC channel, and it is
possible that certain race conditions particularly around exiting a process or
closing the channel might produce a corrupt message.

It might be useful to review IPC interactions if this warning becomes frequent.

### WARN `worker missing when sent signal`

- id
- signal

It is possible that a signal might be sent to a process after it exits.
The cluster supervisor detects this case and compensates depending on whether
the child process is supposed to be running.
This should be unusual.
A high occurrence of this warning could be an indication of thrashing or a bug.

### WARN `worker server closed before it could receive error`

- id
- port

It is possible for a worker to quickly start listening and stop listening
before it receives an address or any connections from the supervisor.

```js
// server.js
server.listen(0);
server.close();
```

This should be unusual since workers tyically stay alive long enough to full
start, and if it does occur, should be due to user intervention.

### WARN `worker server closed before it could accept a connection - redistributing`

- id
- port

This message indicates that the following sequence of events occurred:

- supervisor receives incomming connection and sends it to the worker
- worker closes server
- worker receives connection from the supervisor
- worker returns the connection to the supervisor so it can be sent to an
  active worker, when an active worker becomes available

This should be rare, but can occur during normal operation.
Unless these are frequent, no action should be necessary.

### ERROR `worker forced to shut down`

- id
- pid

Indicates that the worker did not shut down gracefully before the force stop
delay passed and that the supervisor sent the kill signal.

There may be a defect in the worker that prevents it from shutting down in a
timely fashion, including possibly a signal handler that never follows up with
a graceful process exit.
If the process needs more time to shut down gracefully, the
`workerForceStopDelay` option should be extended.

### ERROR `worker stopping because of failure to report health`

- id
- pid

Indicates that the process failed to report its health after it was due, plus
the margin `unhealthyTimeout`.

This may be a symptom of being too busy, in which case the `unhealthyTimeout`
should be extended or load should be distributed elsewhere.
It may also be an indication of an infinite loop, either in JavaScript or
libuv.

### ERROR `worker unexpectedly stopped in standby state`

- id

Indicates that a child process has reported that it stopped more than once.
This is potentially dangerous if the worker restarts immediately, since the
second signal interferes with the new worker process.
If this occurs, please review the logs to ascertain what caused the first and
second `handleStop` state transition and file an issue.

### DEBUG `sending worker's server its listening address`

- port
- address {port, address}

Indicates that the supervisor now has an open server for the requested port and
sends the actual address to the worker so that it can emit the listen event and
store the actual address.

### DEBUG `sending connection to worker`

- id
- port

Indicates that the supervisor has sent a connection to a server in the worker.

### DEBUG `spawned worker got message`

- id
- message

Indicates that the cluster supervisor received a message that is not in its
command vocabulary.
This can occur normally if a specialized worker and supervisor piggy-back on
the Node.js IPC channel.


## Load Balancer Logs

### INFO `connection backlog`

Indicates the number of connections waiting to be distributed to workers.
The `length` will be 0 and `grew` false whenever the supervisor flushes
incoming connections to available workers.
This message will be logged each time a connection gets enqueued.

- port
- length: the number of queued connections
- grew?

### INFO `supervisor stopped listening on port`

- port

Indicates that the supervisor has stopped listening for requests to the given
port.

### ERROR `supervisor failed to listen`

- port
- error

Indicates that the load balancer was unable to listen on the requested port
with the given error.
This error gets distributed to all workers that attempt to listen on this port
hereafter and the supervisor will need to be restarted.

### WARN `supervisor shutting down server before confirmed to be listening`

- port

This will occur if the load balancer is stopped before it has finished starting.
This should be rare in normal operation, and should only occur in response to
manual shutdown.

### DEBUG `worker subscribed to connections`

- id
- port
- count: the new number of worker supervisors in the ring

Indicates that a worker has subscribed to incoming connections on this port.

### DEBUG `supervisor requesting to listen on port`

- port

Indicates that the load balancer has requested a server on this port.

### DEBUG `supervisor received address to listen on port`

- port
- address

Indicates that the load balancer has a server that is now listening on the
given actual address.


## Installation

`npm install nanny`

## Tests

`npm test`

## Contributors

 - tomuber
 - jakev
 - kriskowal

## MIT Licensed

