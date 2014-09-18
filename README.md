# clustermon

This module abstracts logic for spawning workers via node cluster.

## Example

```js
// launcher.js
var Clustermon = require("clustermon");
var clustermon = new Clustermon({
    exec: path.join(__dirname, "worker.js"),
    initMaster: function() {
        // additional master initialization
    },
    respawnWorkerCount: 1,  // When workers exit, retry spawning up to x times. -1 for infinite.
    numCPUs: 8,             // Number of workers to spawn. Default is # cores.
    logicalIds: [5, 6, 7]   // Give workers an env variable "PROCESS_LOGICAL_ID" based on
                            // the values in the array and the order of the array.
});
clustermon.start();

// worker.js
process.title = 'worker';
// initialize worker stuff here...

```

## Docs

### `var clustermon = new Clustermon(/*arguments*/)`

```ocaml
clustermon := (arg: Any) => void
```

This module abstracts logic for spawning workers via node cluster.

## Installation

`npm install clustermon`

## Tests

`npm test`

## Contributors

 - tomuber
 - jakev

## MIT Licensed
