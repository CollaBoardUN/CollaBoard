import React from 'react';

interface CollaBoardLogoProps {
  size?: number;
  className?: string;
}

/**
 * CollaBoardLogo
 * Logo oficial de CollaBoard: Isotipo con una 'B' estilizada en ángulo
 * sobre gradiente Índigo (#4F46E5) y Cian (#0EA5E9).
 */
export const CollaBoardLogo: React.FC<CollaBoardLogoProps> = ({ size = 32, className = '' }) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flexShrink: 0 }}
      aria-label="CollaBoard Logo"
    >
      <defs>
        <linearGradient id="cbGradPixel" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
        <linearGradient id="accentGradPixel" x1="12" y1="10" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E0E7FF" />
        </linearGradient>
        <linearGradient id="facetGradPixel" x1="20" y1="10" x2="36" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#818CF8" />
        </linearGradient>
      </defs>

      {/* Escudo contenedor con esquinas redondeadas */}
      <rect width="48" height="48" rx="12" fill="url(#cbGradPixel)" />

      {/* Letra 'B' estilizada con cortes geométricos en ángulo */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M13 10H27L34 17V20.5L29.5 24.5L35 29.5V32.5L29.5 38H13V10ZM18.5 15V21H24.5L28 18L24.5 15H18.5ZM18.5 27V33H25L29 30L25 27H18.5Z"
        fill="url(#accentGradPixel)"
      />

      {/* Facetas poligonales angulares */}
      <path
        d="M27 10L34 17H28L24.5 15H27Z"
        fill="url(#facetGradPixel)"
        opacity="0.9"
      />
      <path
        d="M29.5 24.5L35 29.5H29L25 27H29.5Z"
        fill="url(#facetGradPixel)"
        opacity="0.9"
      />
    </svg>
  );
};
