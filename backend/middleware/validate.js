/**
 * Validates req.body/req.params/req.query against a Zod schema. On
 * failure, throws a ZodError which errorHandler.js turns into a
 * consistent 400 response with field-level messages. On success,
 * replaces req.body/params/query with the PARSED (and coerced/defaulted)
 * data, so route handlers can trust the shape and types of what they
 * receive instead of re-checking `typeof`/`isNaN` themselves.
 */

function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      next();
    } catch (err) {
      next(err); // ZodError -> handled centrally by errorHandler.js
    }
  };
}

module.exports = { validate };
