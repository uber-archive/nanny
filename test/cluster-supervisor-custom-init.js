
var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');
var path = require('path');

test('extended init ClusterSupervisor', function (assert) {
    var supervisor = new ClusterSupervisor({
        initMaster: function () {
            assert.equal(true, true);
        },
        exec: path.join(__dirname, 'mock-server.js'),
        respawnWorkerCount: 0,
        numCPUs: 8
    });

    supervisor.start();

    setTimeout(function () {
        supervisor.stop();
        assert.end();
    }, 1000);
});

