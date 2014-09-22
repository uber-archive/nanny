
var ClusterSupervisor = require('../cluster-supervisor.js');
var test = require('tape');

test('extended init ClusterSupervisor', function (assert) {
    var supervisor = new ClusterSupervisor({
        initMaster: function () {
            assert.equal(true, true);
        },
        exec: __dirname + '/mock-server.js',
        respawnWorkerCount: 0,
        numCPUs: 8
    });
    var cluster = supervisor.start();

    if (cluster) {
        setTimeout(function () {
            Object.keys(cluster.workers).forEach(function (id) {
                cluster.workers[id].kill();
            });

            assert.end();
        }, 1000);
    }
});

