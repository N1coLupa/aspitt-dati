export function slugify(input) {
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function stopKey(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bang\.?\b/g, 'angolo')
    .replace(/\bs\.?v\.?\b/g, 'strada vicinale')
    .replace(/\bp\.?zza\b/g, 'piazza')
    .replace(/\bv\.?le\b/g, 'viale')
    .replace(/\bfr\.?\b/g, 'fronte')
    .replace(/\(pensilina\)|pensilina/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
