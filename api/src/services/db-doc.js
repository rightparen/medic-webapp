const db = require('../db-pouch'),
      authorization = require('./authorization'),
      _ = require('underscore');

const getStoredDoc = (params, method, query, isAttachment) => {
  if (!params || !params.docId) {
    return Promise.resolve(false);
  }

  let options = {};
  // use `req.query` params for `db-doc` GET, as we will return the result directly if allowed
  // use `req.query.rev` for attachment requests
  // `db-doc` PUT and DELETE requests will require latest `rev` to be allowed
  if ((method === 'GET' || isAttachment) && query) {
    options = query;
  }

  return db.medic
    .get(params.docId, options)
    .catch(err => {
      if (err.status === 404) {
        return false;
      }

      throw err;
    });
};

const getRequestDoc = (method, body, isAttachment) => {
  // bodyParser adds a `body` property regardless of method
  // attachment requests are not bodyParsed, so theoretically will not have a `body` property
  if (method === 'GET' || method === 'DELETE' || isAttachment || !body) {
    return false;
  }

  return body;
};

module.exports = {
  // offline users will only be able to:
  // - GET/DELETE `db-docs` they are allowed to see
  // - POST `db-docs` they will be allowed to see
  // - PUT `db-docs` they are and will be allowed to see
  // - GET/PUT/DELETE `attachments` of `db-docs` they are allowed to see
  // this filters audited endpoints, so valid requests are allowed to pass through to the next route
  filterOfflineRequest: (userCtx, params, method, query, body) => {
    const isAttachment = params.attachmentId;

    return Promise
      .all([
        getStoredDoc(params, method, query, isAttachment),
        getRequestDoc(method, body, isAttachment),
        authorization.getAuthorizationContext(userCtx)
      ])
      .then(([ storedDoc, requestDoc, authorizationContext ]) => {
        if (!storedDoc && !requestDoc) {
          return false;
        }

        // user must be allowed to see existent document
        if (storedDoc &&
            !authorization.allowedDoc(storedDoc._id, authorizationContext, authorization.getViewResults(storedDoc)) &&
            !authorization.isDeleteStub(storedDoc)) {
          return false;
        }

        // user must be allowed to see new/updated document or be allowed to create this document
        if (requestDoc &&
            !authorization.alwaysAllowCreate(requestDoc) &&
            !authorization.allowedDoc(requestDoc._id, authorizationContext, authorization.getViewResults(requestDoc))) {
          return false;
        }

        if (method === 'GET' && !isAttachment) {
          // we have already requested the doc with same query options
          return storedDoc;
        }

        return true;
      });
  },
};

// used for testing
if (process.env.UNIT_TEST_ENV) {
  _.extend(module.exports, {
    _getStoredDoc: getStoredDoc,
    _getRequestDoc: getRequestDoc
  });
}
