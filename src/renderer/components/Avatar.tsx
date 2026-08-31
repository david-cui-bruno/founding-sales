const initialsFor = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
};

export type AvatarProps = {
  name: string;
};

/** Neutral initials avatar. The full person name stays the accessible name. */
export function Avatar({ name }: AvatarProps) {
  return (
    <span className="avatar" role="img" aria-label={name}>
      {initialsFor(name)}
    </span>
  );
}
