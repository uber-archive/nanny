
'use strict';

var ClusterSupervisor = require('../cluster-supervisor.js');
var path = require('path');

var supervisor = new ClusterSupervisor({
    respawnWorkerCount: 0,
    exec: path.join(__dirname, 'hodor-net-client.js'),
    numCPUs: 4,
    pulse: 100,
    unhealthyTimeout: 5e3,
    createEnvironment: function () {
        return {
            HODOR_NAME: this.id,
            HODOR_PORT: process.env.HODOR_PORT || 0,
            NODE_DEBUG: process.env.NODE_DEBUG
        };
    },
    isHealthy: function (health) {
        return health.memoryUsage.rss < 100e6;
    },
    workerRestartDelay: 4000,
    workerForceStopDelay: 3000
});

supervisor.start();

