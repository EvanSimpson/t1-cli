#!/usr/bin/env node

var common = require('../src/cli')
  , colors = require('colors')
  , util = require('util')
  ;

// Setup cli.
common.basic();

// Command-line arguments
var argv = require("nomnom")
  .script('tessel wifi')
  .option('list', {
    abbr: 'l',
    flag: true,
    help: '[Tessel] List available wifi networks.',
  })
  .option('network', {
    abbr: 'n',
    help: '[Tessel] The network to connect to.'
  })
  .option('password', {
    abbr: 'p',
    help: '[Tessel] Password of the network. Omit for unsecured networks.'
  })
  .option('security', {
    abbr: 's',
    default: 'wpa2',
    help: '[Tessel] Security type of the network, one of (wpa2|wpa|wep). Omit for unsecured networks.'
  })
  .option('timeout', {
    abbr: 't',
    default: 20,
    help: '[Tessel] Sets timeout before retrying connection to network.'
  })
  .option('help', {
    abbr: 'h',
    help: '[Tessel] Show usage for tessel wifi'
  })
  .parse();

function usage () {
  console.error(require('nomnom').getUsage());
  process.exit(1);
}

common.controller(false, function (err, client) {
  if (argv.list) {
    client.listen(true, null); // TODO: should use [20, 21, 22, 86] once firmware logs at the right level
    client.wifiStatus(function (err, data) {
      Object.keys(data).map(function (key) {
        if (key.toUpperCase() == "IP"){
          // reverse key.data
          data[key] = data[key].split(".").reverse().join(".");
        }
        console.log(key.replace(/^./, function (a) { return a.toUpperCase(); }) + ':', data[key]);
      })
      client.close();
    })

  } else {
    if (!argv.network){
      usage();
    }

    function retry () {
      var ssid = argv.network;
      var pass = argv.password || "";
      var security = (argv.security || (pass ? 'wpa2' : 'unsecure')).toLowerCase();

      console.error('Connecting to "%s" with %s security...', ssid, security);
      client.configureWifi(ssid, pass, security, {
        timeout: argv.timeout
      }, function (data) {
        if (data.error) {
          console.error('Error in connecting (%d). Please try again.', data.error);
          process.on('exit', function () {
            process.exit(1);
          })
          client.close();
        } else if (!data.connected && !argv['no-retry']) {
          console.error('Could not connect. Check that your network and password are correct.');
          client.close();
        } else {
          console.error('Connected!\n');

          console.log('IP\t', data.ip);
          console.log('DNS\t', data.dns);
          console.log('DHCP\t', data.dhcp);
          console.log('Gateway\t', data.gateway);
          client.close();
        }
      });
    }

    // Flush earlier USB network messages.
    // TODO: Actually flush these.
    setTimeout(retry, 250);
  }
})
