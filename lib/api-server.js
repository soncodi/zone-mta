'use strict';

const config = require('config');
const log = require('npmlog');
const restify = require('restify');
const sendingZone = require('./sending-zone');

class APIServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.createServer();
    }

    createServer() {
        this.server = restify.createServer();
        this.server.use(restify.bodyParser({
            mapParams: true
        }));

        this.server.use(restify.authorizationParser());

        this.setupRoutes();
    }

    start(callback) {
        let returned = false;
        this.server.on('error', err => {
            if (returned) {
                return log.error('API', err);
            }
            returned = true;
            return callback(err);
        });

        this.server.listen(config.api.port, config.api.host, () => {
            if (returned) {
                return this.server.close();
            }
            returned = true;
            callback(null, true);
        });
    }

    close(callback) {
        this.closing = true;
        this.server.close(callback);
    }

    setupRoutes() {

        // test authentication example
        this.server.get('/test-auth', (req, res, next) => {
            let time = new Date().toISOString();

            if (req.username !== config.feeder.user || req.authorization.basic.password !== config.feeder.pass) {
                res.statusCode = 401;
                res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
                return res.json({
                    time,
                    error: 'Authentication required'
                });
            }

            // the actual response does not matter as long as it's 2xx range
            res.json({
                time,
                user: req.username
            });

            next();
        });

        // general information about some zone
        this.server.get('/queue/:zone', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }

            let time = new Date().toISOString();
            let queued = 0;
            let deferred = 0;
            let domains = [];
            let processed = 0;
            let started = time;
            let stats = this.queue.stats.zoneQueued.get(req.params.zone);
            if (stats) {
                queued = stats.queued;
                deferred = stats.deferred;
                processed = stats.processed;
                started = new Date(stats.started).toISOString();
                if (stats.domains) {
                    stats.domains.forEach((data, domain) => {
                        domains.push({
                            domain,
                            queued: data.queued,
                            deferred: data.deferred
                        });
                    });
                }
            }
            res.json({
                time,
                started,
                processed,
                queued,
                deferred,
                domains
            });
            next();
        });

        // Streams message contents
        this.server.get('/fetch/:instance/:client/:id', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }
            if (this.queue.instanceId !== req.params.instance) {
                res.json(410, {
                    error: 'Invalid or expired instance ID provided'
                });
                return next();
            }
            this.queue.messageExists(req.params.id, (err, exists) => {
                if (err) {
                    res.json(500, {
                        error: err.message
                    });
                    return next();
                }
                if (!exists) {
                    res.json(404, {
                        error: 'Selected message does not exist'
                    });
                    return next();
                }
                res.writeHead(200, {
                    'Content-Type': 'message/rfc822'
                });
                this.queue.retrieve(req.params.id).pipe(res);
            });
        });

        // Finds and locks details for next delivery
        this.server.get('/get/:instance/:client/:zone', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }
            if (this.queue.instanceId !== req.params.instance) {
                res.json(410, {
                    error: 'Invalid or expired instance ID provided'
                });
                return next();
            }
            let zone = sendingZone.get(req.params.zone);
            if (!zone) {
                res.json(404, {
                    error: 'Selected Sending Zone does not exist'
                });
                return next();
            }
            zone.getNextDelivery(req.params.client, (err, delivery) => {
                if (err) {
                    log.error('API', err.message);
                    res.json(500, {
                        error: err.message
                    });
                    return next();
                }
                if (!delivery) {
                    res.json({
                        id: false
                    });
                    return next();
                }
                let data = {};
                Object.keys(delivery).forEach(key => {
                    if (delivery[key]) {
                        data[key] = key.charAt(0) !== '_' || typeof delivery[key] !== 'string' ? delivery[key] : Buffer.from(delivery[key]).toString('base64');
                    }
                });
                res.json(data);
                next();
            });
        });

        // Marks a delivery as done (either bounced or accepted)
        // Does not check the validity of instance id since we need this data
        this.server.post('/release-delivery/:instance/:client/:zone', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }
            let zone = sendingZone.get(req.params.zone);
            if (!zone) {
                res.json(404, {
                    error: 'Selected Sending Zone does not exist'
                });
                return next();
            }

            let delivery = req.body.delivery;
            Object.keys(delivery).forEach(key => {
                if (delivery[key] && key.charAt(0) === '_' && typeof delivery[key] === 'string') {
                    delivery[key] = Buffer.from(delivery[key], 'base64').toString();
                }
            });

            zone.releaseDelivery(delivery, err => {
                if (err) {
                    log.error('API', err.message);
                    res.json(500, {
                        error: err.message
                    });
                } else {
                    res.send(202, delivery.id + '.' + delivery.seq);
                }
                return next();
            });
        });

        // Marks a delivery as deferred
        // Does not check the validity of instance id since we need this data
        this.server.post('/defer-delivery/:instance/:client/:zone', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }
            let zone = sendingZone.get(req.params.zone);
            if (!zone) {
                res.json(404, {
                    error: 'Selected Sending Zone does not exist'
                });
                return next();
            }

            let delivery = req.body.delivery;
            Object.keys(delivery).forEach(key => {
                if (delivery[key] && key.charAt(0) === '_' && typeof delivery[key] === 'string') {
                    delivery[key] = Buffer.from(delivery[key], 'base64').toString();
                }
            });

            zone.deferDelivery(delivery, Number(req.body.ttl), err => {
                if (err) {
                    log.error('API', err.message);
                    res.json(500, {
                        error: err.message
                    });
                } else {
                    res.send(202, delivery.id + '.' + delivery.seq);
                }
                return next();
            });
        });
    }
}

module.exports = options => new APIServer(options);