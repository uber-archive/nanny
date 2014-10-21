// Worker fixture for worker-argv-test.
'use strict';
process.send({cmd: 'TEST_RESULT', result: process.argv});
