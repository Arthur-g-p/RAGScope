import React from 'react';

export type PillVariant = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'tag-blue' | 'tag-red';
export type PillSize = 'xxs' | 'xs' | 'sm' | 'md';

interface PillProps {
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
  variant: PillVariant;
  size?: PillSize;
  tooltip?: string;
  className?: string;
}

const Pill: React.FC<PillProps> = ({
  label,
  count,
  active = true,
  onClick,
  variant,
  size = 'sm',
  tooltip,
  className = '',
}) => {
  const variantClasses: Record<PillVariant, { active: string; inactive: string }> = {
    success: {
      active: 'bg-green-50 text-green-700 border-green-200',
      inactive: 'bg-white text-gray-400 border-gray-200',
    },
    danger: {
      active: 'bg-red-50 text-red-700 border-red-200',
      inactive: 'bg-white text-gray-400 border-gray-200',
    },
    warning: {
      active: 'bg-yellow-50 text-yellow-600 border-yellow-200',
      inactive: 'bg-white text-gray-400 border-gray-200',
    },
    info: {
      active: 'bg-blue-50 text-blue-700 border-blue-200',
      inactive: 'bg-white text-gray-400 border-gray-200',
    },
    neutral: {
      active: 'bg-gray-50 text-gray-700 border-gray-200',
      inactive: 'bg-white text-gray-400 border-gray-200',
    },
    'tag-blue': {
      active: 'qi-tag-blue',
      inactive: 'qi-tag-blue',
    },
    'tag-red': {
      active: 'qi-tag-red',
      inactive: 'qi-tag-red',
    },
  };

  const sizeClasses: Record<PillSize, string> = {
    xxs: 'qi-pill-xxs',
    xs: 'px-1.5 py-0.5 text-xs',
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
  };

  const colorClasses = active ? variantClasses[variant].active : variantClasses[variant].inactive;
  const stateClass = active ? 'qi-pill-active' : 'qi-pill-inactive';

  const baseClasses = `qi-pill rounded-full border ${sizeClasses[size]} ${colorClasses} ${stateClass} ${className}`;

  if (onClick) {
    return (
      <button
        type="button"
        className={baseClasses}
        onClick={onClick}
        title={tooltip}
        aria-pressed={active}
      >
        {label} {count !== undefined && count}
      </button>
    );
  }

  return (
    <span className={baseClasses} title={tooltip}>
      {label} {count !== undefined && count}
    </span>
  );
};

export default Pill;
