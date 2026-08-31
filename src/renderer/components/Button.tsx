import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'quiet' | 'danger';

export type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

/** Standard action button. Neutral by default; variants stay semantic. */
export function Button({
  variant = 'primary',
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button {...rest} type={type} className={`button button--${variant}`}>
      {children}
    </button>
  );
}
