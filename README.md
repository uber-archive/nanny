
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
var ClusterSupervisor = require("nanny");
var supervisor = new ClusterSupervisor({

    exec: path.join(__dirname, "worker.js"),
    workerCount: 8,             // Number of workers to spawn. Default is # cores.
    logicalIds: [5, 6, 7]       // Give workers an env variable
                                // "PROCESS_LOGICAL_ID" based on the values in
                                // the array and the order of the array.

    // Configure the supervisor's behavior:

    pulse: 1000,                // The interval at which workers will attempt
                                // to submit their memory usage and load statistics.
    unhealthyTimeout: 10e3,     // The maximum delay in miliseconds after an
                                // expected heart beat that a worker supervisor
                                // will tolerate before stopping a stalled
                                // worker.
    serverRestartDelay: 1000,   // The period that a load balancer will wait before
                                // attempting to restart a socket server.
    workerForceStopDelay: 1000, // The period that a worker supervisor will wait between
                                // a stop command and when it will
                                // automatically force stop with a kill signal.
                                // Set to Infinity to disable.
    workerRestartDelay: 1000,   // The period that a worker will wait between
                                // when a worker stops and when it will attempt
                                // to restart it.
    respawnWorkerCount: 1,      // When workers exit, retry spawning up to x
                                // times. -1 for infinite.

    // Override the child process parameters for each worker:

    execPath: '/usr/bin/node',  // An alternate Node.js binary to use to spawn
                                // worker processes.
    execArgv: [],               // An alternate set of command line arguments
                                // for Node.js to spawn the worker process.
    cwd: '/',                   // The working directory for each worker
                                // process.
    encoding: 'utf-8',          // Encoding for standard IO of the worker.
    silent: false,              // Pipes the worker standard IO into the
                                // supervisor process instead of inheriting the
                                // supervisor's own standard IO.

    // Introduce additional cluster supervisor initialization.
    // `this` is the cluster supervisor.
    initMaster: function() {
    },

    // Override the method used to create the worker environment.
    // `this` is a worker supervisor and `this.id` is its logical id.
    createEnvironment: function (logicalId) {
        return {
            PROCESS_LOGICAL_ID: logicalId
        };
    },

    // Override the health check method of the worker supervisor.
    // If this returns false, the worker process fails and will be stopped.
    // The health check will occur on the same interval as the worker's health
    // report (pulse) but may be offset by as much under normal conditions.
    isHealthy: function (health) {
        return health.memoryUsage.rss < 700e6;
    },

    // Override the logger for the cluster. By default, we create a debuglog
    // named 'nanny' visible with `NODE_DEBUG=nanny`.
    logger: console

});

supervisor.start();
supervisor.stop();
supervisor.inspect();
supervisor.countWorkers();
supervisor.countRunningWorkers();
supervisor.countActiveWorkers();
supervisor.countRunningLoadBalancers();
supervisor.countActiveLoadBalancers();
supervsior.forEachWorker(function (workerSupervisor) { });
supervisor.forEachLoadBalancer(function (loadBalancer) { });
```

```js
// worker.js
process.title = 'worker';
// initialize worker stuff here...
```

`execPath`, `execArgv`, `encoding`, `cwd`, and `silent` are passed through to
Node.js's own [child_process][].

[child_process]: http://nodejs.org/api/child_process.html

The cluster supervisor, worker supervisors, and load balancers, are all event emitters.

The worker supervisor emits 'health' events when the child process reports its
memory usage and load metrics.


## Docs

### `var supervisor = new ClusterSupervisor(/*arguments*/)`

```ocaml
ClusterSupervisor := (spec: SupervisorSpec) => void
```

This module abstracts logic for spawning workers via node cluster.

## Installation

`npm install nanny`

## Tests

`npm test`

## Contributors

 - tomuber
 - jakev
 - kriskowal

## MIT Licensed

