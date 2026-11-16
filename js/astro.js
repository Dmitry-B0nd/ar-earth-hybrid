// Астрономия: вращение Земли и положение Солнца.
// Системы координат:
//   ECI  — инерциальная: X → точка весеннего равноденствия, Z → северный полюс (звёзды «стоят»)
//   ECEF — связанная с Землёй: X → гринвичский меридиан на экваторе, Z → северный полюс
const DEG = Math.PI / 180;

// Юлианская дата
export const julianDate = (date) => date.getTime() / 86400000 + 2440587.5;

// Звёздное время Гринвича (радианы) — на какой угол Земля повёрнута относительно звёзд
export function gmst(date) {
  const d = julianDate(date) - 2451545.0;
  const deg = (280.46061837 + 360.98564736629 * d) % 360;
  return ((deg + 360) % 360) * DEG;
}

// Направление на Солнце в ECI (единичный вектор [x, y, z]); точность ~0.01°, для визуализации с запасом
export function sunDirectionEci(date) {
  const n = julianDate(date) - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * DEG;           // средняя долгота
  const g = (357.528 + 0.9856003 * n) * DEG;           // средняя аномалия
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;  // эклиптическая долгота
  const eps = (23.439 - 0.0000004 * n) * DEG;          // наклон эклиптики
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}
