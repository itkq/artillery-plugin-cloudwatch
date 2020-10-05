'use strict';

const debug = require('debug')('artillery:cloudwatch');

var aws = require('aws-sdk'),
    constants = {
        PLUGIN_NAME: 'cloudwatch',
        PLUGIN_PARAM_NAMESPACE: 'namespace',
        PLUGIN_PARAM_REGION: 'region',
        PLUGIN_PARAM_DIMENSIONS: 'dimensions',
        THE: 'The "',
        CONFIG_REQUIRED: '" plugin requires configuration under <script>.config.plugins.',
        PARAM_REQUIRED: '" parameter is required',
        PARAM_MUST_BE_STRING: '" param must have a string value',
        PARAM_MUST_HAVE_LENGTH_OF_AT_LEAST_ONE: '" param must have a length of at least one',
        PARAM_MUST_BE_ARRAY: '" param must have an array value',
        PARAM_MUST_BE_OBJECT: '" param must have an object value',
        // Report Array Positions
        TIMESTAMP: 0,
        REQUEST_ID: 1,
        LATENCY: 2,
        STATUS_CODE: 3
    },
    messages = {
        pluginConfigRequired: constants.THE + constants.PLUGIN_NAME + constants.CONFIG_REQUIRED + constants.PLUGIN_NAME,
        pluginParamNamespaceRequired: constants.THE + constants.PLUGIN_PARAM_NAMESPACE + constants.PARAM_REQUIRED,
        pluginParamNamespaceMustBeString: constants.THE + constants.PLUGIN_PARAM_NAMESPACE + constants.PARAM_MUST_BE_STRING,
        pluginParamNamespaceMustHaveALengthOfAtLeastOne: constants.THE + constants.PLUGIN_PARAM_NAMESPACE + constants.PARAM_MUST_HAVE_LENGTH_OF_AT_LEAST_ONE,
        pluginParamRegionRequired: constants.THE + constants.PLUGIN_PARAM_REGION + constants.PARAM_REQUIRED,
        pluginParamRegionMustBeString: constants.THE + constants.PLUGIN_PARAM_REGION + constants.PARAM_MUST_BE_STRING,
        pluginParamRegionMustHaveALengthOfAtLeastOne: constants.THE + constants.PLUGIN_PARAM_REGION + constants.PARAM_MUST_HAVE_LENGTH_OF_AT_LEAST_ONE,
        pluginParamDimensionsMustBeObject: constants.THE + constants.PLUGIN_PARAM_DIMENSIONS + constants.PARAM_MUST_BE_OBJECT,
    },
    impl = {
        validateConfig: function(scriptConfig) {
            // Validate that plugin config exists
            if (!(scriptConfig && scriptConfig.plugins && constants.PLUGIN_NAME in scriptConfig.plugins)) {
                throw new Error(messages.pluginConfigRequired);
            }
            // Validate NAMESPACE
            if (!(constants.PLUGIN_PARAM_NAMESPACE in scriptConfig.plugins[constants.PLUGIN_NAME])) {
                throw new Error(messages.pluginParamNamespaceRequired);
            } else if (!('string' === typeof scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_NAMESPACE] ||
                scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_NAMESPACE] instanceof String)) {
                throw new Error(messages.pluginParamNamespaceMustBeString);
            } else if (scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_NAMESPACE].length === 0) {
                throw new Error(messages.pluginParamNamespaceMustHaveALengthOfAtLeastOne);
            }
            // Validate REGION
            if (!(constants.PLUGIN_PARAM_REGION in scriptConfig.plugins[constants.PLUGIN_NAME])) {
                throw new Error(messages.pluginParamRegionRequired);
            } else if (!('string' === typeof scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_REGION] ||
                scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_REGION] instanceof String)) {
                throw new Error(messages.pluginParamRegionMustBeString);
            } else if (scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_REGION].length === 0) {
                throw new Error(messages.pluginParamRegionMustHaveALengthOfAtLeastOne);
            }
            // Validate DIMENSIONS
            if (!(constants.PLUGIN_PARAM_DIMENSIONS in scriptConfig.plugins[constants.PLUGIN_NAME])) {
                // OK with no config
            }
            else if (!('object' === typeof scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_DIMENSIONS])) {
                throw new Error(pluginParamDimensionsMustBeObject);
            }
        },
        buildLatencyMetricData: function(report, timestamp, dimensions) {
            var latencies = report._latencies;
            var averageLatency = latencies.reduce(function(a, b) { return a + b }, 0) / latencies.length;

            return [
                {
                    MetricName: 'AverageLatency',
                    Dimensions: dimensions,
                    Timestamp: (new Date(timestamp)).toISOString(),
                    Value: averageLatency / 1000000,
                    Unit: 'Milliseconds'
                },
            ];
        },
        buildStatusCodeMetricData: function(report, timestamp, dimensions) {
            var statusCodes = {
                '2XX': 0,
                '3XX': 0,
                '4XX': 0,
                '5XX': 0,
            };

            report._entries.forEach(function (entry) {
                var code = entry[constants.STATUS_CODE];
                var roundedCode = `${String(code)[0]}XX`;
                statusCodes[roundedCode]++;
            });

            return Object.getOwnPropertyNames(statusCodes).filter(function(roundedCode){
                return statusCodes[roundedCode] > 0;
            }).map(function (roundedCode) {
                return {
                    MetricName: roundedCode,
                    Dimensions: dimensions,
                    Timestamp: timestamp,
                    Value: statusCodes[roundedCode],
                    Unit: 'None',
                };
            });
        },
        buildErrorMetricData: function(report, timestamp, dimensions) {
            var errorCount = 0;

            Object.getOwnPropertyNames(report._errors).forEach(function (propertyName) {
                errorCount += report._errors[propertyName];
            });

            return [
                {
                    MetricName: 'Error',
                    Dimensions: dimensions,
                    Timestamp: timestamp,
                    Value: errorCount,
                    Unit: 'None',
                },
            ];
        },
        buildDimensions: function(dimensionConfig) {
            if (typeof dimensionConfig !== 'undefined') {
                return Object.entries(dimensionConfig).map((elem) => { return { Name: elem[0], Value: elem[1] } });
            } else {
                return [];
            }
        },
        buildTimestamp: function(report) {
            var timestamp = Math.max.apply(null, report._requestTimestamps);
            // XXX: why occur??
            if (timestamp == -Infinity) {
                debug(report);
                // It's better to use exception instead
                return null;
            }

            return (new Date(timestamp)).toISOString();
        },
        CloudWatchPlugin: function(scriptConfig, eventEmitter) {
            var self = this,
                reportError = function (err) {
                    if (err) {
                        console.log('Error reporting metrics to CloudWatch via putMetricData:', err);
                    }
                };
            self.config = JSON.parse(JSON.stringify(scriptConfig.plugins[constants.PLUGIN_NAME]));
            eventEmitter.on('stats', function (report) {
                if (typeof report._entries === 'undefined' || report._entries.length === 0) {
                    return;
                }
                var timestamp = impl.buildTimestamp(report);
                if (timestamp === null) {
                    console.log('Failed to get timestamp value, skip to report');
                    return;
                }

                var dimensions = impl.buildDimensions(self.config[constants.PLUGIN_PARAM_DIMENSIONS]);
                var metricData = impl.buildLatencyMetricData(report, timestamp, dimensions);
                metricData = metricData.concat(impl.buildStatusCodeMetricData(report, timestamp, dimensions));
                metricData = metricData.concat(impl.buildErrorMetricData(report, timestamp, dimensions));

                var putMetricDataParams = {
                    Namespace: self.config[constants.PLUGIN_PARAM_NAMESPACE],
                    MetricData: metricData,
                };

                impl.cloudWatch.putMetricData(putMetricDataParams, reportError);
                // console.log('Metrics reported to CloudWatch');
            });
        }
    },
    api = {
        init: function (scriptConfig, eventEmitter) {
            impl.validateConfig(scriptConfig);
            impl.cloudWatch = new aws.CloudWatch({region: scriptConfig.plugins[constants.PLUGIN_NAME][constants.PLUGIN_PARAM_REGION]});
            return new impl.CloudWatchPlugin(scriptConfig, eventEmitter);
        }
    };

/**
 * Configuration:
 *  {
 *      "config": {
 *          "plugins": {
 *              "cloudwatch": {
 *                  "namespace": "[INSERT_NAMESPACE]",
 // *                  "metrics": [
 // *                      {
 // *                          "name": "[METRIC_NAME]",
 // *                          "dimensions": [...],
 // *
 // *                      }
 // *                  ]
 *              }
 *          }
 *      }
 *  }
 */
module.exports = api.init;

/* test-code */
module.exports.constants = constants;
module.exports.messages = messages;
module.exports.impl = impl;
module.exports.api = api;
/* end-test-code */
