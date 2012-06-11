/**
 * Update functions to be exported from the design doc.
 */

var _ = require('underscore')._,
    logger = require('kujua-utils').logger,
    jsonforms = require('views/lib/jsonforms'),
    smsparser = require('views/lib/smsparser'),
    validate = require('./validate'),
    utils = require('./utils');


/**
 * @param {String} form - jsonforms key string
 * @param {Object} form_data - parsed form data
 * @returns {String} - Referral ID value
 * @api private
 */
var getRefID = function(form, form_data) {
    switch(form) {
        case 'MSBC':
            return form_data.cref_rc[0];
        case 'MSBB':
            return form_data.ref_rc[0];
        case 'MSBR':
            return form_data.ref_rc[0];
    }
};

/**
 * @param {String} phone - phone number of the sending phone (from)
 * @param {Object} doc - sms_message doc created from initial POST
 * @param {Object} form_data - parsed form data
 * @returns {Object} - body for callback
 * @api private
 */
var getCallbackBody = function(phone, doc, form_data) {
    var type = 'data_record',
        form = doc.form,
        def = jsonforms[form];

    var body = {
        type: type,
        from: phone,
        form: form,
        related_entities: {clinic: null},
        errors: [],
        tasks: [],
        reported_date: new Date().getTime(),
        // keep message datat part of record
        sms_message: doc
    };

    // try to parse timestamp from gateway
    var ts = parseSentTimestamp(doc.sent_timestamp);
    if (ts) {
        body.reported_date = ts;
    }

    if(utils.isReferralForm(form)) {
        body.refid = getRefID(form, form_data);
    }

    for (var k in def.fields) {
        var field = def.fields[k];
        smsparser.merge(form, k.split('.'), body, form_data, doc.format);
    }

    var errors = validate.validate(def, form_data);

    if(errors.length > 0) {
        body.errors = errors;
    }

    if(form_data.extra_fields) {
        body.errors.push({code: "extra_fields"});
    }

    return body;
};

/**
 * @param {String} phone - phone number of the sending phone (from)
 * @param {String} form - jsonforms key string
 * @param {Object} form_data - parsed form data
 * @returns {String} - Path for callback
 * @api private
 */
var getCallbackPath = function(phone, form, form_data) {
    var path = '';

    switch(form) {
        case 'MSBC':
            path = '/%1/data_record/add/refid/%2'
                      .replace('%1', encodeURIComponent(form))
                      .replace('%2', encodeURIComponent(
                          getRefID(form, form_data)));
            break;
        case 'MSBB':
            path = '/%1/data_record/add/health_center/%2'
                      .replace('%1', encodeURIComponent(form))
                      .replace('%2', encodeURIComponent(phone));
            break;
        default:
            path = '/%1/data_record/add/clinic/%2'
                      .replace('%1', encodeURIComponent(form))
                      .replace('%2', encodeURIComponent(phone));
    }

    return path;
};

/*
 * Try to parse SMSSync gateway sent_timestamp field and use it for
 * reported_date.  Particularly useful when re-importing data from gateway to
 * maintain accurate reported_date field.
 *
 * return unix timestamp string or undefined
 */
var parseSentTimestamp = function(str) {
    if(!str) { return; }
    var match = str.match(/(\d{2})-(\d{2}|\d{1})-(\d{2})\s(\d{2}):(\d{2})/);
    if (match) {
        var ret = new Date();
        ret.setMonth(parseInt(match[1],10) - 1);
        ret.setYear('20'+match[3]); //HACK for two-digit year
        ret.setDate(match[2]);
        ret.setHours(match[4]);
        ret.setMinutes(match[5]);
        return ret.getTime();
    }
};

/*
 * Return Ushahidi SMSSync compatible response message.  Supports custom
 * auto-reply message in the form definition. Also uses callbacks to create
 * 1st phase of tasks_referral doc.
 */
var getRespBody = function(doc, req) {
    var form = doc.form,
        def = jsonforms[form],
        form_data = smsparser.parse(form, def, doc, 1),
        baseURL = require('duality/core').getBaseURL(),
        headers = req.headers.Host.split(":"),
        host = headers[0],
        port = headers[1] || "",
        phone = doc.from, // set by gateway
        autoreply = utils.getMessage('success', doc.locale),
        errormsg = '',
        resp = {
            //smssync gateway response format
            payload: {
                success: true,
                task: "send",
                messages: [{
                    to: phone,
                    message: autoreply}]}};

    if (!doc.message || !doc.message.trim()) {
        errormsg = utils.getMessage('error', doc.locale);
    } else if (!form || !def) {
        errormsg = utils.getMessage({code:'form_not_found', form: form}, doc.locale)
    }

    if (errormsg) {
        // TODO integrate with kujua notifications?
        resp.payload.messages[0].message = errormsg;
        logger.error({'error':errormsg, 'doc':doc});
        return JSON.stringify(resp);
    }

    if (def.autoreply) {
        resp.payload.messages[0].message = def.autoreply;
    }

    // provide callback for next part of record creation.
    resp.callback = {
        options: {
            host: host,
            port: port,
            path: baseURL + getCallbackPath(phone, form, form_data),
            method: "POST",
            headers: {'Content-Type': 'application/json; charset=utf-8'}},
        data: getCallbackBody(phone, doc, form_data)};

    if(resp.callback.data.errors.length > 0) {
        resp.payload.messages[0].message = _.map(resp.callback.data.errors, function(err) {
            return utils.getMessage(err, doc.locale);
        }).join(', ');
    }

    // pass through Authorization header
    if(req.headers.Authorization) {
        resp.callback.options.headers.Authorization = req.headers.Authorization;
    }

    return JSON.stringify(resp);
};
exports.getRespBody = getRespBody;

/*
 * Parse an sms message and if we discover a supported format save a data
 * record.
 */
exports.add_sms = function (doc, req) {
    return [null, getRespBody(_.extend(req.form, {
        type: "sms_message",
        format: smsparser.getSMSFormat(req.form.message),
        locale: (req.query && req.query.locale) || 'en',
        form: smsparser.getForm(req.form.message)
    }), req)];
};

exports.add = function (doc, req) {
};
