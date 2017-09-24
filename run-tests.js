"use strict";

/*  ---------------------------------------------------------------------------

    A tests launcher. Runs tests for all languages and all exchanges, in
    parallel, with a humanized error reporting.

    Usage: node run-tests [--php] [--js] [--python] [--python3] [exchange] [symbol]

    --------------------------------------------------------------------------- */

const fs = require ('fs')
const log = require ('ololog')//.configure ({ indent: { pattern: '  ' }})
const ansi = require ('ansicolor').nice

/*  --------------------------------------------------------------------------- */

process.on ('uncaughtException',  e => { log.bright.red.error (e); process.exit (1) })
process.on ('unhandledRejection', e => { log.bright.red.error (e); process.exit (1) })

/*  --------------------------------------------------------------------------- */

const [,, ...args] = process.argv

const keys = {

    '--js': false,      // run JavaScript tests only
    '--php': false,     // run PHP tests only
    '--python': false,  // run Python 2 tests only
    '--python3': false, // run Python 3 tests only
}

let exchanges = []
let symbol = 'all'

for (const arg of args) {
    if (arg.startsWith ('--'))   { keys[arg] = true }
    else if (arg.includes ('/')) { symbol = arg }
    else                         { exchanges.push (arg) }
}

/*  --------------------------------------------------------------------------- */

if (!exchanges.length) {

    if (!fs.existsSync ('exchanges.json')) {

        log.bright.red ('\n\tNo', 'exchanges.json'.white, 'found, please run', 'npm run build'.white, 'to generate it!\n')
        process.exit (1)
    }

    exchanges = JSON.parse (fs.readFileSync ('exchanges.json')).ids
}

/*  --------------------------------------------------------------------------- */

const sleep = ms => new Promise (resolve => setTimeout (resolve, ms))
const timeout = (ms, promise) => Promise.race ([ promise, sleep (ms).then (() => { throw new Error ('timed out') }) ])

/*  --------------------------------------------------------------------------- */

const exec = (bin, ...args) =>

/*  A custom version of child_process.exec that captures both stdout and
    stderr,  not separating them into distinct buffers — so that we can show
    the same output as if it were running in a terminal.                        */

    new Promise (return_ => {

        const ps = require ('child_process').spawn (bin, args)

        let output = ''
        let stderr = ''
        let hasWarnings = false

        ps.stdout.on ('data', data => { output += data.toString () })
        ps.stderr.on ('data', data => { output += data.toString (); stderr += data.toString (); hasWarnings = true })

        ps.on ('exit', code => {
            return_ ({
                failed: code !== 0,
                output,
                hasWarnings,
                warnings: ansi.strip (stderr).match (/^\[[^\]]+\]/g) || []
            })
        })
    })

/*  ------------------------------------------------------------------------ */

let numExchangesTested = 0

/*  Tests of different languages for the same exchange should be run
    sequentially to prevent the interleaving nonces problem.
    ------------------------------------------------------------------------ */

const sequentialMap = async (input, fn) => {

    const result = []
    for (const item of input) { result.push (await fn (item)) }
    return result
}

/*  ------------------------------------------------------------------------ */

const testExchange = async (exchange) => {

    const nonce = Date.now ()

/*  Run tests for all/selected languages (in parallel)     */

    const args = [exchange, ...symbol === 'all' ? [] : symbol]
        , allTests = [

            { language: 'JavaScript', key: '--js',      exec: ['node',      'test/test.js',       ...args] },
            { language: 'Python',     key: '--python',  exec: ['python',    'test/test.py',       ...args] },
            { language: 'Python 3',   key: '--python3', exec: ['python3',   'test/test_async.py', ...args] },
            { language: 'PHP',        key: '--php',     exec: ['php', '-f', 'test/test.php',      ...args] }
        ]
        , selectedTests  = allTests.filter (t => keys[t.key])
        , scheduledTests = selectedTests.length ? selectedTests : allTests
        , completeTests  = await sequentialMap (scheduledTests, async test => Object.assign (test, await exec (...test.exec)))
        , failed      = completeTests.find (test => test.failed)
        , hasWarnings = completeTests.find (test => test.hasWarnings)
        , warnings    = completeTests.reduce ((total, { warnings }) => total.concat (warnings), [])

/*  Print interactive log output    */

    numExchangesTested++

    const percentsDone = ((numExchangesTested / exchanges.length) * 100).toFixed (0) + '%'

    log.bright (('[' + percentsDone + ']').dim, 'Testing', exchange.cyan, (failed      ? 'FAIL'.red :
                                                                          (hasWarnings ? (warnings.length ? warnings.join (' ') : 'WARN').yellow
                                                                                       : 'OK'.green)))

/*  Return collected data to main loop     */

    return {

        exchange,
        failed,
        hasWarnings,
        explain () {
            for (const { language, failed, output, hasWarnings } of completeTests) {
                if (failed || hasWarnings) {

                    if (failed) { log.bright ('\nFAILED'.bgBrightRed.white, exchange.red,    '(' + language + '):\n') }
                    else        { log.bright ('\nWARN'.yellow.inverse,      exchange.yellow, '(' + language + '):\n') }

                    log.indent (1) (output)
                }
            }
        }
    }
}

/*  ------------------------------------------------------------------------ */

function TaskPool ({ maxTime, maxConcurrency }) {
    
    const pending = []
        , queue   = []

    let numActive = 0
        
    return {

        all: () => Promise.all (pending),
        
        run (task) {
            
            if (numActive >= maxConcurrency) { // queue task

                return new Promise (resolve => queue.push (() => this.run (task).then (resolve)))

            } else { // execute task

                let p = timeout (maxTime, task ()).then (x => {
                    numActive--
                    console.log (numActive)
                    return (queue.length && (numActive < maxConcurrency))
                                ? queue.shift () ().then (() => x)
                                : x
                })
                numActive++
                console.log (numActive)             
                pending.push (p)
                return p
            }
        }
    }
}

/*  ------------------------------------------------------------------------ */

async function testAllExchanges () {

    // NOTE: naive impl crashes with out-of-memory-error eventually (in Travis), so need some pooling...
    //
    // return Promise.all (exchanges.map (testExchange))

    const taskPool = TaskPool ({ maxTime: 120*1000, maxConcurrency: 50 })

    for (const ex of exchanges) {
        taskPool.run (() => testExchange (ex))
    }

    return taskPool.all ()
}

/*  ------------------------------------------------------------------------ */

(async function () {

    log.bright.magenta.noPretty ('Testing'.white, { exchanges, symbol, keys })

    const tested    = await testAllExchanges ()
        , warnings  = tested.filter (t => !t.failed && t.hasWarnings)
        , failed    = tested.filter (t =>  t.failed)
        , succeeded = tested.filter (t => !t.failed && !t.hasWarnings)

    log.newline ()

    warnings.forEach (t => t.explain ())
    failed.forEach (t => t.explain ())

    log.newline ()

    if (failed.length)   { log.noPretty.bright.red    ('FAIL'.bgBrightRed.white,    failed  .map (t => t.exchange)) }
    if (warnings.length) { log.noPretty.bright.yellow ('WARN'.inverse, warnings.map (t => t.exchange)) }

    log.newline ()

    log.bright ('All done,', [failed.length    && (failed.length    + ' failed')   .red,
                              succeeded.length && (succeeded.length + ' succeeded').green,
                              warnings.length  && (warnings.length  + ' warnings') .yellow].filter (s => s).join (', '))

    if (failed.length) {

        await sleep (10000) // to fight TravisCI log truncation issue, see https://github.com/travis-ci/travis-ci/issues/8189
        process.exit (1)
    }

}) ();

/*  ------------------------------------------------------------------------ */
