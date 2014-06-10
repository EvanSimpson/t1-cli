#!/usr/bin/env node
// Copyright 2014 Technical Machine, Inc. See the COPYRIGHT
// file at the top-level directory of this distribution.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

var path = require('path')

var common = require('../src/cli')
  , keypress = require('keypress')
  , read = require('read')
  , colors = require('colors')
  , builds = require('../src/builds')
  , util = require('util')
  , logs = require('../src/logs')
  , repl = require('repl')
  ;

var colonyCompiler = require('colony-compiler')
var fs = require('fs')

// Setup cli.
common.basic();

// Command-line arguments
var argv = require("nomnom")
  .script('tessel run')
  .option('script', {
    position: 0,
    // required: true,
    full: 'script.js',
    help: 'Run this script on Tessel.',
  })
  .option('arguments', {
    position: 1,
    list: true,
    help: 'Arguments to pass in as process.argv.'
  })
  .option('version', {
    abbr: 'v',
    flag: true,
    help: 'Print tessel-node\'s version.',
    callback: function() {
      return require('./package.json').version.replace(/^v?/, 'v');
    }
  })
  .option('interactive', {
    abbr: 'i',
    flag: true,
    help: 'Enter the REPL.'
  })
  .option('upload-dir', {
    abbr: 'u',
    flag: false,
    help: 'Directory where uploads from process.sendfile should be saved to'
  })
  // .option('remote', {
  //   abbr: 'r',
  //   flag: true,
  //   help: '[Tessel] Push code to a Tessel by IP address.'
  // })
  .option('quiet', {
    abbr: 'q',
    flag: true,
    help: '[Tessel] Hide tessel deployment messages.'
  })
  .option('single', {
    abbr: 's',
    flag: true,
    help: '[Tessel] Push a single script file to Tessel.'
  })
  .option('help', {
    abbr: 'h',
    flag: true,
    help: 'Show usage for tessel node'
  })
  .parse();

argv.verbose = !argv.quiet;

function usage () {
  console.error(require('nomnom').getUsage());
  process.exit(1);
}

function interactiveClient (client)
{
  function convertToContext (cmd) {
    var self = this, matches,
        scopeVar = /^\s*var\s*([_\w\$]+)(.*)$/m,
        scopeFunc = /^\s*function\s*([_\w\$]+)/;

    // Replaces: var foo = "bar";  with: self.context.foo = bar;
    matches = scopeVar.exec(cmd);
    if (matches && matches.length === 3) {
      return matches[1] + matches[2];
    }

    // Replaces: function foo() {};  with: foo = function foo() {};
    matches = scopeFunc.exec(self.bufferedCommand);
    if (matches && matches.length === 2) {
      return matches[1] + ' = ' + self.bufferedCommand;
    }

    return cmd;
  };

  client.once('message', function () {
    // one message to start with
    repl.start({
      prompt: '> ',
      eval: function (cmd, context, filename, callback) {
        client.once('message', function (data) {
          callback(data.error, data.value);
        });

        try {
          var data = convertToContext(cmd.slice(1, -2));
          var script
            = 'local function _run ()\n' + colonyCompiler.colonize(data, {returnLastStatement: true, wrap: false}) + '\nend\nsetfenv(_run, colony.global);\nreturn _run()';
          client.send(script);
        } catch (e) {
          console.error(e.stack);
          callback();
        }
      },
    })
    .on('exit', function () {
      client.close();
    })
  });
}

common.controller(true, function (err, client) {
  client.on('error', function (err) {
    if (err.code == 'ENOENT') {
      logs.err('Cannot connect to Tessel locally.')
    } else {
      console.error(err);
    }
  })

  // Check pushing path.
  if (argv.interactive) {
    var pushpath = path.resolve(__dirname, '../scripts/repl');
  } else if (!argv.script) {
    usage();
  } else {
    var pushpath = argv.script;
  }

  // Command command.
  var updating = false;
  client.on('upload-status', function () {
    if (updating) {
      // Interrupted by other deploy
      process.exit(0);
    }
    updating = true;
  });

  builds.checkBuildList(client.version, function (allBuilds, needUpdate){
    if (!allBuilds) return pushCode();

    if (needUpdate){
      // show warning
      logs.warn("There is a newer version of firmware available. You should run \"tessel update\".");
    }
    
    pushCode();
  });

  function pushCode(){
    client.run(pushpath, ['tessel', pushpath].concat(argv.arguments || []), function () {
      // script-start emitted.
      logs.info('Running script...');

      // Forward pipes.
      client.stdout.resume();
      client.stdout.pipe(process.stdout);
      client.stderr.resume();
      client.stderr.pipe(process.stderr);
      process.stdin.resume();
      process.stdin.pipe(client.stdin);

      // Stop on Ctrl+C.
      process.on('SIGINT', function() {
        setTimeout(function () {
          // timeout :|
          logs.info('Script aborted');
          process.exit(131);
        }, 200);
        client.stop();
      });

      client.once('script-stop', function (code) {
        client.close(function () {
          process.exit(code);
        });
      });

      var deets = [], profile = {};
      client.on('rawMessage:0078', function (data) {
        // process.stdout.write('.');
        var obj = {};
        String(data).split(/\n/).forEach(function (line) {
          var key = line.split(' ', 2);
          obj[key[0]] = key[1];
        })
        if (obj.type == 'out') {
          var last = deets.pop();
          if (last) {
            (profile[last.source + ':' + last.line] || (profile[last.source + ':' + last.name] = [])).push([last.start, obj.end]);
          }
        } else {
          deets.push(obj);
        }
      })
      process.once('exit', function () {
        console.error(profile);
        console.error(deets.map(function (line) {
          return line.source + ':' + line.line;
        }))
      })

      client.on('rawMessage:4113', function (data) {
        if (!argv['upload-dir']) {
          logs.err('ignoring uploaded file. call tessel with --upload-dir to save files from a running script.');
          return;
        }

        try {
          var packet = require('structured-clone').deserialize(data);
          fs.writeFileSync(path.resolve(argv['upload-dir'], path.basename(packet.filename)), packet.buffer);
          logs.info(util.format(packet.filename, 'saved to', argv['upload-dir']));
        } catch (e) {
          logs.err('invalid sendfile packet received.');
        }
      });
      
      // repl is implemented in repl/index.js. Uploaded to tessel, it sends a
      // message telling host it's ready, then receives stdin via
      // process.on('message')
      if (argv.interactive) {
        interactiveClient(client);
      }
    });
  }
  
})
