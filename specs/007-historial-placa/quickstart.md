# Quickstart: Historial clínico por placa (007)

## Pruebas automatizadas

```bash
# Backend e2e del historial (requiere Docker / PostgreSQL de desarrollo)
cd backend
npx vitest run test/vehicle-history.e2e-spec.ts

# Frontend unit tests del componente de historial
cd frontend
npx ng test --include=src/app/features/vehicles/vehicle-history/vehicle-history.component.spec.ts --watch=false
```

## Verificación manual en desarrollo

1. Iniciar el backend y sembrar datos de desarrollo:
   ```bash
   cd backend && npm run start:dev
   ```
2. Iniciar el frontend con proxy:
   ```bash
   cd frontend && npm start
   ```
3. Iniciar sesión como asesor (`admin@taller-a.test` o asesor de pruebas).
4. Buscar un vehículo por su placa en la pantalla principal `/` (ej. vehículo con check-ins y órdenes generadas).
5. En la ficha técnica del vehículo (`/vehicles/:id`), hacer clic en el botón **Historial clínico**.
6. Comprobar:
   - Tarjetas de métricas: odómetro actual calculado, número de check-ins y OT, total invertido.
   - Filtros de timeline: alternar entre "Todos", "Check-ins", "Presupuestos", "Órdenes de trabajo".
   - Navegación: hacer clic en un evento para abrir su detalle.
   - Impresión: presionar `Ctrl+P` y comprobar la vista limpia para entregar al cliente.
