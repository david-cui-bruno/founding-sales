import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children' | 'aria-label'
> & {
  /** Required accessible name for the icon-only control. */
  label: string;
  icon: LucideIcon;
};

/** Icon-only button that always carries an accessible name and tooltip. */
export function IconButton({
  label,
  icon: Icon,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className="icon-button"
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" size={16} />
    </button>
  );
}
