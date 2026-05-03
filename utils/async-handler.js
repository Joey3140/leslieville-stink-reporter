// Wrap async Express handlers so rejected promises forward to the error middleware
// instead of becoming unhandled rejections (Express 4 doesn't auto-catch async).
function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
