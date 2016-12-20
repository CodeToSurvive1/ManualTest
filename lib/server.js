var adb = require('adbkit');
var Promise = require('bluebird');
var cp = require('child_process');
var http = require('http');
var colors = require("colors");
var detect = require('detect-port');
var client = adb.createClient();
var path = require('path');
var pathUtil = require('./util');
var util = require('util')
var co = require('co');
var WebSocketServer = require('websocket').server;
var net = require('net');

var resources = {
    bin: {
        dest: '/data/local/tmp/minicap'
        , comm: 'minicap'
        , mode: 0755
    }
    , lib: {
        dest: '/data/local/tmp/minicap.so'
        , mode: 0755
    }
}


// for android
function* getDeviceList() {
    var arrDeviceList = [];
    var strText = cp.execSync('adb devices').toString();
    strText.replace(/(.+?)\s+device\r?\n/g, function (all, deviceName) {
        arrDeviceList.push({
            udid: deviceName
        });
    });
    return arrDeviceList;
}

function* startServer() {
    var deviceList = yield getDeviceList();
    if (deviceList.length === 0) {
        console.log('device not found'.red);
        process.exit(1);
    } else if (deviceList.length === 1) {
        var udid = deviceList[0].udid;
        console.log('device found :' + udid.red);
        yield pushMiniCapAndTouch(udid);
    } else {
        console.log('multiple devies :', deviceList, ''.red);
    }
};


function* pushMiniCapAndTouch(udid) {
    // get cpu version and sdk version
    yield client.getProperties(udid).then(function (properties) {
        cpu = properties['ro.product.cpu.abi'];
        sdk = properties['ro.build.version.sdk'];
        display = properties['ro.build.version.sdk'];
    });

    //system version<16 needs minicap-nopie else minicap  
    var minicapPath = 'minicap-prebuilt/prebuilt/' + cpu + '/bin/minicap' + (sdk >= 16 ? '' : '-nopie');
    var minicapSoPath = 'minicap-prebuilt/prebuilt/' + cpu + '/lib/android-' + sdk + '/minicap.so';



    //push minicap and minicap.so
    yield client.push(udid, pathUtil.module(minicapPath), resources.bin.dest, resources.bin.mode);
    yield client.push(udid, pathUtil.module(minicapSoPath), resources.lib.dest, resources.bin.mode);


    //push mini touch 
    var minitouchPath = 'minitouch/' + cpu + '/minitouch' + (sdk >= 16 ? '' : '-nopie');
    yield client.push(udid, pathUtil.vendor(minitouchPath), '/data/local/tmp/minitouch', 0755);


    //get screen width and height
    yield client.shell(udid, 'wm size').then(adb.util.readAll)
        .then(function (output) {
            output.toString().replace(/Physical size: (.+?)\s+\r?\n/g, function (all, devicesName) {
                display = devicesName.toString().trim();
            });
        });

    cp.execSync('adb forward --remove-all');
    yield startHttpServer(udid, display);
}


function* startHttpServer(udid, display) {
    var serverPort = yield detect(9765);
    var server = http.createServer();
    server.listen(serverPort, function () {
        console.log('----', serverPort);
    });

    wsServer = new WebSocketServer({
        httpServer: server,
        autoAcceptConnections: true
    });

    wsServer.on('connect', co.wrap(function* (connection) {

        //start minicap
        yield client.shell(udid, util.format(
            'LD_LIBRARY_PATH=%s exec %s %s'
            , path.dirname(resources.lib.dest)
            , resources.bin.dest
            , '-P ' + display + '@' + display + '/0'
        ));

        // start minitouch
        yield client.shell(udid, '/data/local/tmp/minitouch');
        //minitouch adb forward
        var minitouchPort = yield detect(1111);
        console.log('minitouchPort', minitouchPort);
        yield client.forward(udid, 'tcp:' + minitouchPort, 'localabstract:minitouch');

        var touchStream = net.connect({
            port: minitouchPort
        });

        touchStream.on('close', function () {
            console.log('touch end--tcp', minitouchPort);
            cp.execSync('adb forward --remove tcp:' + minitouchPort);
        });

        //minicap adb forward
        var minicapPort = yield detect(1313);
        console.log('minicapPort', minicapPort);
        yield client.forward(udid, 'tcp:' + minicapPort, 'localabstract:minicap');

        var stream = net.connect({
            port: minicapPort
        });


        stream.on('error', function () {
            console.error('Be sure to run `adb forward tcp:1313 localabstract:minicap`')
            process.exit(1)
        });

        stream.on('close', function () {
            console.log('minicap end--tcp', minicapPort);
            cp.execSync('adb forward --remove tcp:' + minicapPort);
        });

        wsConnection = connection;

        var readBannerBytes = 0
        var bannerLength = 2
        var readFrameBytes = 0
        var frameBodyLength = 0
        var frameBody = new Buffer(0)
        var banner = {
            version: 0
            , length: 0
            , pid: 0
            , realWidth: 0
            , realHeight: 0
            , virtualWidth: 0
            , virtualHeight: 0
            , orientation: 0
            , quirks: 0
        }

        function tryRead() {
            for (var chunk; (chunk = stream.read());) {
                // console.info('chunk(length=%d)', chunk.length)
                for (var cursor = 0, len = chunk.length; cursor < len;) {
                    if (readBannerBytes < bannerLength) {
                        switch (readBannerBytes) {
                            case 0:
                                // version
                                banner.version = chunk[cursor]
                                break
                            case 1:
                                // length
                                banner.length = bannerLength = chunk[cursor]
                                break
                            case 2:
                            case 3:
                            case 4:
                            case 5:
                                // pid
                                banner.pid +=
                                    (chunk[cursor] << ((readBannerBytes - 2) * 8)) >>> 0
                                break
                            case 6:
                            case 7:
                            case 8:
                            case 9:
                                // real width
                                banner.realWidth +=
                                    (chunk[cursor] << ((readBannerBytes - 6) * 8)) >>> 0
                                break
                            case 10:
                            case 11:
                            case 12:
                            case 13:
                                // real height
                                banner.realHeight +=
                                    (chunk[cursor] << ((readBannerBytes - 10) * 8)) >>> 0
                                break
                            case 14:
                            case 15:
                            case 16:
                            case 17:
                                // virtual width
                                banner.virtualWidth +=
                                    (chunk[cursor] << ((readBannerBytes - 14) * 8)) >>> 0
                                break
                            case 18:
                            case 19:
                            case 20:
                            case 21:
                                // virtual height
                                banner.virtualHeight +=
                                    (chunk[cursor] << ((readBannerBytes - 18) * 8)) >>> 0
                                break
                            case 22:
                                // orientation
                                banner.orientation += chunk[cursor] * 90
                                break
                            case 23:
                                // quirks
                                banner.quirks = chunk[cursor]
                                break
                        }

                        cursor += 1
                        readBannerBytes += 1

                        if (readBannerBytes === bannerLength) {
                            console.log('banner', banner)
                        }
                    }
                    else if (readFrameBytes < 4) {
                        frameBodyLength += (chunk[cursor] << (readFrameBytes * 8)) >>> 0
                        cursor += 1
                        readFrameBytes += 1
                        // console.info('headerbyte%d(val=%d)', readFrameBytes, frameBodyLength)
                    }
                    else {
                        if (len - cursor >= frameBodyLength) {
                            console.info('bodyfin(len=%d,cursor=%d)', frameBodyLength, cursor)

                            frameBody = Buffer.concat([
                                frameBody
                                , chunk.slice(cursor, cursor + frameBodyLength)
                            ])

                            // Sanity check for JPG header, only here for debugging purposes.
                            if (frameBody[0] !== 0xFF || frameBody[1] !== 0xD8) {
                                console.error(
                                    'Frame body does not start with JPG header', frameBody)
                                process.exit(1)
                            }

                            connection.send(frameBody, {
                                binary: true
                            })

                            cursor += frameBodyLength
                            frameBodyLength = readFrameBytes = 0
                            frameBody = new Buffer(0)
                        }
                        else {
                            // console.info('body(len=%d)', len - cursor)

                            frameBody = Buffer.concat([
                                frameBody
                                , chunk.slice(cursor, len)
                            ])

                            frameBodyLength -= len - cursor
                            readFrameBytes += len - cursor
                            cursor = len
                        }
                    }
                }
            }
        }

        stream.on('readable', tryRead);

        connection.on('message', function (message) {
            console.log('收到消息', message);
            var message = message.utf8Data;
            try {
                message = JSON.parse(message);
            }
            catch (e) { };
            var type = message.type;
            console.log('type', type);
            switch (type) {
                case 'command':
                    saveCommand(udid, message.data.cmd, message.data.data, touchStream);
                    break;
            }

        });
        connection.on('close', function (reasonCode, description) {
            wsConnection = null;
            console.info('Lost a client')
            stream.end();
            touchStream.end();
        });
    }));
}

function saveCommand(udid, cmd, data, touchStream) {

    switch (cmd) {
        case 'click':
            touchStream.write('r\n');
            touchStream.write('d 0 ' + data.touchX + ' ' + data.touchY + '\n');
            touchStream.write('c\n');
            touchStream.write('u 0\n');
            touchStream.write('c\n');
            break;
        case 'swipe':
            touchStream.write('d 0 ' + data.startX + ' ' + data.startY + ' 50\n');
            touchStream.write('c\n');
            touchStream.write('m 0 ' + data.endX + ' ' + data.endY + ' 50\n');
            touchStream.write('c\n');
            touchStream.write('u 0\n');
            touchStream.write('c\n');
            break;
        case 'back':
            client.shell(udid, 'input keyevent 4');
            break;
        case 'home':
            client.shell(udid, 'input keyevent 3');
            break;
        case 'menu':
            client.shell(udid, 'input keyevent 82');
            break;
    }

}

module.exports = startServer;
