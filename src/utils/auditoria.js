export async function registrarAuditoria(connection, {
  req = null,
  usuarioId = null,
  modulo,
  accion,
  entidad = null,
  entidadId = null,
  datosAntes = null,
  datosDespues = null
}) {
  const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
  const userAgent = req?.headers?.['user-agent'] || null;

  await connection.query(
    `
    INSERT INTO auditoria_acciones (
      usuario_id,
      modulo,
      accion,
      entidad,
      entidad_id,
      datos_antes,
      datos_despues,
      ip,
      user_agent
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      usuarioId || req?.user?.id || null,
      modulo,
      accion,
      entidad,
      entidadId !== null && entidadId !== undefined ? String(entidadId) : null,
      datosAntes ? JSON.stringify(datosAntes) : null,
      datosDespues ? JSON.stringify(datosDespues) : null,
      ip,
      userAgent
    ]
  );
}