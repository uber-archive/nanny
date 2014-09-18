var Clustermon = require('../index.js');
var test = require('tape');

test('Clustermon is a function', function (assert) {
    assert.strictEqual(typeof Clustermon, 'function');
    assert.end();
});
