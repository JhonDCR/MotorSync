-- T059: reference volume of SC-001 / US1-AC10 / FR-005 (data-model.md, "Volumen de referencia").
-- 10 talleres x (30 000 clientes + 50 000 vehiculos) = 800 000 business rows, built with
-- generate_series. Every document, plate and VIN is valid (same rules as research R7 and the
-- CHECK constraints of clients and vehicles) and unique per taller.
--
-- Run as motorsync_migrator (DATABASE_MIGRATOR_URL) over an empty, already migrated database:
--   psql "$DATABASE_MIGRATOR_URL" -v ON_ERROR_STOP=1 -f test/perf/seed-volume.sql
-- test/perf/search.perf-spec.ts loads it by itself when the perf tenants are missing.
--
-- clients and vehicles have FORCE ROW LEVEL SECURITY, so even their owner only sees and writes
-- the rows of app_current_tenant(): the tenant is pinned with set_config('app.tenant_id', ..., true)
-- before the inserts of each taller, inside one transaction (all or nothing).
--
-- Deterministic ids (md5 of a label, with the version nibble forced to 4 and the variant to 8
-- so that they are well-formed v4 uuids: the JWT guard rejects any other tenant_id), so the
-- owner of each vehicle is computed without lookups:
--   tenant  t: md5('motorsync-perf-tenant-' || t)
--   client  n: md5('motorsync-perf-client-' || t || '-' || n)
--   vehicle n: md5('motorsync-perf-vehicle-' || t || '-' || n)
--
-- Documents (client n = 1..30 000):
--   n % 10 = 0 -> company, RUC of a private company: province || '9' || lpad(n, 7) || '001'
--   n % 10 = 1 -> natural, passport: 'A' || letter || lpad(n, 7)
--   otherwise  -> natural, cedula: province (01-24) || third digit (0-5) || lpad(n, 6)
--                 || modulo 10 check digit (coefficients 2,1,2,1,2,1,2,1,2)
-- Plates (vehicle n = 1..50 000):
--   n % 10 = 0 -> motorcycle, k = n / 10 - 1 (0..4 999): 2 letters || 100 + k % 900 || letter k / 900
--   otherwise  -> car, m = n - n / 10 - 1 (0..44 999): 3 letters from (m * 104729) % 26^3
--                 || 1000 + m % 9000. Unique: equal digits imply m2 = m1 + 9000 j (j <= 4) and
--                 104729 * 9000 * j is never a multiple of 26^3 = 2^3 * 13^3.
--   The same plates exist in every taller (allowed: unique per taller), which also exercises
--   the isolation of the search.
-- VIN: NULL when n % 7 = 0; otherwise WMI (3) || VDS (5) || taller digit (1) || lpad(n, 8),
--   only characters of ^[A-HJ-NPR-Z0-9]{17}$ (no I, O or Q).

SET client_encoding = 'UTF8';

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE name LIKE 'Taller rendimiento %') THEN
    RAISE EXCEPTION 'seed-volume: the perf tenants (Taller rendimiento NN) already exist';
  END IF;
END
$$;

INSERT INTO tenants (id, name)
SELECT overlay(overlay(md5('motorsync-perf-tenant-' || t) placing '4' from 13) placing '8' from 17)::uuid,
       'Taller rendimiento ' || lpad(t::text, 2, '0')
FROM generate_series(1, 10) AS t;

DO $$
DECLARE
  seed_user constant uuid := '00000000-0000-4000-8000-00000000f059';
  seed_user_name constant text := 'Carga de rendimiento';
  given_names constant text[] := ARRAY[
    'José', 'María', 'Andrés', 'Sofía', 'Martín', 'Lucía', 'Héctor', 'Inés', 'Ramón', 'Verónica',
    'Iván', 'Mónica', 'Óscar', 'Raúl', 'Belén', 'Joaquín', 'Ana', 'Carlos', 'Gabriela', 'Nicolás',
    'Débora', 'Julián', 'Valeria', 'Sebastián', 'Camila', 'Tomás', 'Rocío', 'Germán', 'Fabián'];
  family_names constant text[] := ARRAY[
    'Pérez', 'Gómez', 'Núñez', 'Rodríguez', 'Hernández', 'Martínez', 'López', 'Sánchez', 'Muñoz',
    'Ibáñez', 'Álvarez', 'Chávez', 'Peña', 'Gutiérrez', 'Jiménez', 'Domínguez', 'Benítez', 'Suárez',
    'Vásquez', 'Cárdenas', 'Andrade', 'Zambrano', 'Quiñónez', 'Ordóñez', 'Calderón', 'Montaño',
    'Castañeda', 'Briceño', 'Guzmán', 'León', 'Mejía'];
  company_kinds constant text[] := ARRAY[
    'Transportes', 'Distribuidora', 'Constructora', 'Importadora', 'Logística', 'Comercial',
    'Agrícola', 'Servicios Técnicos'];
  wmis constant text[] := ARRAY['1HG', '2T1', '3VW', 'JHM', 'KMH', '9BW', '8AJ', 'LSG', 'WVW', 'MA3'];
  vdss constant text[] := ARRAY['CM826', 'BURHE', 'DX7AJ', 'FG1B5', 'HJ4C3', 'ZZZ9N', 'ASK2R', 'LT6K8'];
  brands constant text[] := ARRAY[
    'Honda', 'Toyota', 'Volkswagen', 'Honda', 'Hyundai', 'Chevrolet', 'Toyota', 'Chevrolet',
    'Volkswagen', 'Suzuki'];
  models constant text[] := ARRAY[
    'Civic', 'Corolla', 'Jetta', 'CR-V', 'Tucson', 'Onix', 'Hilux', 'Sail', 'Gol', 'Swift'];
  moto_brands constant text[] := ARRAY['Yamaha', 'Honda', 'Suzuki', 'Bajaj', 'Shineray'];
  moto_models constant text[] := ARRAY['FZ 2.0', 'CB 190R', 'GN 125', 'Pulsar NS200', 'XY 150'];
  colors constant text[] := ARRAY[
    'Blanco', 'Negro', 'Plateado', 'Rojo', 'Azul', 'Gris', 'Marrón', 'Verde', 'Beige', 'Champán'];
  car_bodies constant text[] := ARRAY['sedan', 'suv', 'pickup', 'other'];
  t integer;
  tenant uuid;
BEGIN
  FOR t IN 1..10 LOOP
    tenant := overlay(overlay(md5('motorsync-perf-tenant-' || t) placing '4' from 13) placing '8' from 17)::uuid;
    PERFORM set_config('app.tenant_id', tenant::text, true);

    INSERT INTO clients (
      id, tenant_id, client_type, document_type, document_number,
      first_names, last_names, business_name, phone, email,
      created_by, updated_by, updated_by_name)
    SELECT
      overlay(overlay(md5('motorsync-perf-client-' || t || '-' || g.n) placing '4' from 13) placing '8' from 17)::uuid,
      tenant,
      CASE WHEN g.n % 10 = 0 THEN 'company' ELSE 'natural' END,
      CASE WHEN g.n % 10 = 0 THEN 'ruc' WHEN g.n % 10 = 1 THEN 'passport' ELSE 'cedula' END,
      CASE
        WHEN g.n % 10 = 0 THEN d.province || '9' || lpad(g.n::text, 7, '0') || '001'
        WHEN g.n % 10 = 1 THEN 'A' || chr(65 + g.n % 26) || lpad(g.n::text, 7, '0')
        ELSE d.base9 || cd.check_digit::text
      END,
      CASE WHEN g.n % 10 = 0 THEN NULL
           ELSE given_names[1 + g.n % 29]
                || CASE WHEN g.n % 3 = 0 THEN ' ' || given_names[1 + (g.n / 29) % 29] ELSE '' END
      END,
      CASE WHEN g.n % 10 = 0 THEN NULL
           ELSE family_names[1 + g.n % 31] || ' ' || family_names[1 + (g.n / 31) % 31]
      END,
      CASE WHEN g.n % 10 = 0
           THEN company_kinds[1 + (g.n / 10) % 8] || ' ' || family_names[1 + (g.n / 10) % 31]
                || ' ' || g.n || ' Cía. Ltda.'
           ELSE NULL
      END,
      '09' || lpad(((g.n::bigint * 7919) % 100000000)::text, 8, '0'),
      CASE WHEN g.n % 4 = 0 THEN NULL ELSE 'cliente' || g.n || '@example.com' END,
      seed_user, seed_user, seed_user_name
    FROM generate_series(1, 30000) AS g(n)
    CROSS JOIN LATERAL (
      SELECT lpad((1 + g.n % 24)::text, 2, '0') AS province,
             lpad((1 + g.n % 24)::text, 2, '0') || ((g.n / 24) % 6)::text
               || lpad(g.n::text, 6, '0') AS base9
    ) AS d
    CROSS JOIN LATERAL (
      SELECT (10 - sum(CASE WHEN p.product > 9 THEN p.product - 9 ELSE p.product END) % 10) % 10
               AS check_digit
      FROM (
        SELECT substr(d.base9, i, 1)::int * CASE WHEN i % 2 = 1 THEN 2 ELSE 1 END AS product
        FROM generate_series(1, 9) AS i
      ) AS p
    ) AS cd;

    INSERT INTO vehicles (
      id, tenant_id, owner_client_id, plate, vin, brand, model, year, color, body_type,
      initial_mileage, created_by, updated_by, updated_by_name)
    SELECT
      overlay(overlay(md5('motorsync-perf-vehicle-' || t || '-' || g.n) placing '4' from 13) placing '8' from 17)::uuid,
      tenant,
      overlay(overlay(md5('motorsync-perf-client-' || t || '-' || (1 + (g.n * 7) % 30000))
        placing '4' from 13) placing '8' from 17)::uuid,
      CASE
        WHEN g.n % 10 = 0 THEN
          chr(65 + k.moto2 / 26) || chr(65 + k.moto2 % 26)
          || (100 + k.moto % 900)::text || chr(65 + (k.moto / 900) % 26)
        ELSE
          chr(65 + k.car3 / 676) || chr(65 + (k.car3 / 26) % 26) || chr(65 + k.car3 % 26)
          || (1000 + k.car % 9000)::text
      END,
      CASE WHEN g.n % 7 = 0 THEN NULL
           ELSE wmis[1 + g.n % 10] || vdss[1 + (g.n / 10) % 8] || (t - 1)::text
                || lpad(g.n::text, 8, '0')
      END,
      CASE WHEN g.n % 10 = 0 THEN moto_brands[1 + (g.n / 10) % 5] ELSE brands[1 + g.n % 10] END,
      CASE WHEN g.n % 10 = 0 THEN moto_models[1 + (g.n / 10) % 5] ELSE models[1 + g.n % 10] END,
      1995 + g.n % 31,
      colors[1 + (g.n / 3) % 10],
      CASE WHEN g.n % 10 = 0 THEN 'motorcycle' ELSE car_bodies[1 + g.n % 4] END,
      (g.n::bigint * 7919) % 400000,
      seed_user, seed_user, seed_user_name
    FROM generate_series(1, 50000) AS g(n)
    CROSS JOIN LATERAL (
      SELECT g.n / 10 - 1 AS moto,
             ((g.n / 10 - 1) * 7919) % 676 AS moto2,
             g.n - g.n / 10 - 1 AS car,
             ((g.n - g.n / 10 - 1)::bigint * 104729 % 17576)::int AS car3
    ) AS k;
  END LOOP;
END
$$;

COMMIT;

ANALYZE tenants;
ANALYZE clients;
ANALYZE vehicles;
