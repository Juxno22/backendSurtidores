export function requireRoles(...rolesPermitidos){
    return function rolesMiddleware(req, res, next){
        if(!req.user){
            return res.status(401).json({
                ok: false,
                message: 'No autenticado',
            });
        }

        if(!rolesPermitidos.includes(req.user.rol)){
            return res.status(403).json({
                ok: false,
                message: 'No tienes permiso para realizar esta accion'
            });
        }

        next();
    };
};