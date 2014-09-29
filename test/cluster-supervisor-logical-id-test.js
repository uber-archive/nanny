'use strict';

var ClusterSupervisor = require('../cluster-supervisor.js');
var path = require('path');
var test = require('tape');

test('init ClusterSupervisor with logical IDs', function (assert) {
    var supervisor = new ClusterSupervisor({
        respawnWorkerCount: 1,
        exec: path.join(__dirname, '/mock-server.js'),
        numCPUs: 8,
        logicalIds: [11, 12, 13, 14, 15, 16, 17, 18]
    });
    supervisor.start();

    assert.strictEqual(supervisor.countWorkers(), 8);

    setTimeout(function() {
        supervisor.stop();

        assert.strictEqual(supervisor.countRunningWorkers(), 0);

        setTimeout(function() {
            supervisor.stop();

            assert.end();
        }, 1000);
    }, 1000);
});
