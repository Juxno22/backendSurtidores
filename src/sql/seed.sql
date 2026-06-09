USE db_productividad_surtidores;

INSERT INTO sucursales (nombre, clave, activo)
VALUES
  ('Apizaco', 'APIZACO', 1),
  ('Chiautempan', 'CHIAUTEMPAN', 1),
  ('Acatzingo', 'ACATZINGO', 1),
  ('San Martín', 'SAN_MARTIN', 1),
  ('Símbolos', 'SIMBOLOS', 1),
  ('Eco_Huajuapan', 'ECO_HUAJUAPAN', 1),
  ('Huajuapan', 'HUAJUAPAN', 1),
  ('Teziutlan', 'TEZIUTLAN',1),
  ('Matriz', 'MATRIZ', 1),
  ('Purisima', 'PURISIMA', 1),
  ('Libramiento', 'LIBRAMIENTO', 1)
ON DUPLICATE KEY UPDATE
  clave = VALUES(clave),
  activo = VALUES(activo);