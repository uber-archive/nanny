'use strict';

var ClusterSupervisor = require('../cluster-supervisor.js');
var path = require('path');

function log(message, object) {
    console.log(message + ' ' + JSON.stringify(object));
}

var supervisor = new ClusterSupervisor({
    respawnWorkerCount: 0,
    exec: path.join(__dirname, 'stooge.js'),
    numCPUs: 4,
    logicalIds: ['larry', 'curly', 'moe', 'shemp'],
    pulse: 100,
    unhealthyTimeout: 5e3,
    logger: {debug: log, info: log, error: log, warn: log},
    createEnvironment: function () {
        return {ROLE: this.id};
    },
    isHealthy: function (health) {
        return health.memoryUsage.rss < 100e6;
    },
    workerRestartDelay: 4000,
    workerForceStopDelay: 3000
});

supervisor.start();

setInterval(function () {
    supervisor.inspect().workers.forEach(function (worker) {
        console.log(worker.id, worker.state, worker.pid, worker.health ? worker.health.memoryUsage.rss : null);
    });
    console.log('---');
}, 1000);

