const DETAIL_CHARACTER_THRESHOLD = 64;

export function needsCellDetail(value: string | null): boolean {
  if (value === null) return false;
  return value.length > DETAIL_CHARACTER_THRESHOLD || value.split(/\r\n|\r|\n/).length > 2;
}
