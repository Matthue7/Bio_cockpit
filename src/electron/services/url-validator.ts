/**
 * URL validation and normalization utilities for Q-Sensor API endpoints.
 *
 * Provides validation for HTTP/HTTPS URLs with trailing slash normalization,
 * ensuring consistent URL formatting across dual-API Q-Sensor operations.
 */

export interface ValidatedUrl {
  success: true
  normalizedUrl: string
}

export interface UrlValidationError {
  success: false
  error: string
  originalUrl: string
}

export type UrlValidationResult = ValidatedUrl | UrlValidationError

/**
 * Validate and normalize a Q-Sensor API URL.
 *
 * Rules:
 * - Must be http or https protocol
 * - Remove trailing slashes for consistency
 * - Hostname must be valid (not empty)
 * - Port is optional (defaults to 80/443)
 *
 * @param url - The URL to validate and normalize
 * @param context - Optional context for error messages (e.g., "inWater sensor", "surface sensor")
 * @returns Validation result with normalized URL or error details
 *
 * @example
 * ```typescript
 * const result = validateAndNormalizeQSensorUrl('http://blueos.local:9150/', 'inWater sensor')
 * if (result.success) {
 *   console.log(result.normalizedUrl) // 'http://blueos.local:9150'
 * } else {
 *   console.error(result.error)
 * }
 * ```
 */
export function validateAndNormalizeQSensorUrl(
  url: string,
  context?: string
): UrlValidationResult {
  if (!url || url.trim() === '') {
    return {
      success: false,
      error: `Empty URL provided${context ? ` for ${context}` : ''}`,
      originalUrl: url,
    }
  }

  try {
    const parsed = new URL(url)

    // Protocol validation
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        success: false,
        error: `Invalid protocol "${parsed.protocol}". Must be http or https${context ? ` for ${context}` : ''}`,
        originalUrl: url,
      }
    }

    // Hostname validation
    if (!parsed.hostname || parsed.hostname.trim() === '') {
      return {
        success: false,
        error: `Invalid hostname${context ? ` for ${context}` : ''}`,
        originalUrl: url,
      }
    }

    // Normalize: remove trailing slash, preserve port
    const normalized = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`

    return {
      success: true,
      normalizedUrl: normalized,
    }
  } catch (error: any) {
    return {
      success: false,
      error: `Malformed URL: ${error.message}${context ? ` for ${context}` : ''}`,
      originalUrl: url,
    }
  }
}
