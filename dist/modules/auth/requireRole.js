import { forbidden } from '../../shared/errors.js';
/**
 * Allows only the listed roles. Always put it AFTER requireAuth:
 *   router.use('/users', requireAuth, requireRole('FOUNDER', 'ADMIN'));
 */
export function requireRole(...allowed) {
    // The generic <P> lets this guard sit in front of routes like '/products/:id' without
    // losing the type of req.params.id.
    return (req, _res, next) => {
        if (!req.user || !allowed.includes(req.user.role))
            throw forbidden();
        next();
    };
}
//# sourceMappingURL=requireRole.js.map