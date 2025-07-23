import { Page } from '@playwright/test'

export interface LanguageDetection {
    interfaceLanguage: 'en' | 'fr' | 'es' | 'de' | 'unknown'
    confidence: number
    detectedKeywords: string[]
}

export interface CAPTCHAKeywords {
    title: string[]
    instructions: string[]
    buttons: {
        submit: string[]
        refresh: string[]
        verify: string[]
    }
}

export class CAPTCHALanguageDetector {
    private static readonly LANGUAGE_PATTERNS = {
        en: {
            title: ['verify', 'robot', 'captcha', 'human', 'person'],
            instructions: ['enter', 'type', 'characters', 'text', 'below'],
            buttons: {
                submit: ['submit', 'verify', 'confirm', 'continue'],
                refresh: ['refresh', 'reload', 'new', 'try again'],
                verify: ['verify', 'check', 'validate'],
            },
        },
        fr: {
            title: [
                'vérifiez',
                'robot',
                'captcha',
                'humain',
                'personne',
                'vraie',
            ],
            instructions: [
                'entrez',
                'tapez',
                'caractères',
                'texte',
                'ci-dessous',
            ],
            buttons: {
                submit: ['soumettre', 'vérifier', 'confirmer', 'continuer'],
                refresh: ['actualiser', 'recharger', 'nouveau', 'réessayer'],
                verify: ['vérifier', 'vérifiez', 'valider'],
            },
        },
        es: {
            title: [
                'verificar',
                'robot',
                'captcha',
                'humano',
                'persona',
                'verdadera',
            ],
            instructions: [
                'ingrese',
                'escriba',
                'caracteres',
                'texto',
                'abajo',
            ],
            buttons: {
                submit: ['enviar', 'verificar', 'confirmar', 'continuar'],
                refresh: ['actualizar', 'recargar', 'nuevo', 'intentar'],
                verify: ['verificar', 'comprobar', 'validar'],
            },
        },
        de: {
            title: [
                'überprüfen',
                'roboter',
                'captcha',
                'mensch',
                'person',
                'echte',
            ],
            instructions: ['eingeben', 'tippen', 'zeichen', 'text', 'unten'],
            buttons: {
                submit: ['senden', 'überprüfen', 'bestätigen', 'fortfahren'],
                refresh: ['aktualisieren', 'neu laden', 'neu', 'versuchen'],
                verify: ['überprüfen', 'prüfen', 'validieren'],
            },
        },
    }

    /**
     * Detect the language of a CAPTCHA interface
     */
    public static async detectCAPTCHALanguage(
        page: Page,
    ): Promise<LanguageDetection> {
        try {
            // Get all text content from the page
            const pageText = await page.evaluate(() => {
                return {
                    bodyText: document.body.innerText.toLowerCase(),
                    titleText: document.title.toLowerCase(),
                    buttonTexts: Array.from(
                        document.querySelectorAll(
                            'button, input[type="submit"]',
                        ),
                    )
                        .map((el) => el.textContent?.toLowerCase() || '')
                        .filter((text) => text.length > 0),
                }
            })

            const allText = [
                pageText.bodyText,
                pageText.titleText,
                ...pageText.buttonTexts,
            ].join(' ')

            const languageScores: Record<
                string,
                { score: number; keywords: string[] }
            > = {}

            // Score each language based on keyword matches
            for (const [lang, patterns] of Object.entries(
                this.LANGUAGE_PATTERNS,
            )) {
                let score = 0
                const foundKeywords: string[] = []

                // Check title keywords (highest weight)
                for (const keyword of patterns.title) {
                    if (allText.includes(keyword)) {
                        score += 3
                        foundKeywords.push(keyword)
                    }
                }

                // Check instruction keywords (medium weight)
                for (const keyword of patterns.instructions) {
                    if (allText.includes(keyword)) {
                        score += 2
                        foundKeywords.push(keyword)
                    }
                }

                // Check button keywords (medium weight)
                for (const buttonType of Object.values(patterns.buttons)) {
                    for (const keyword of buttonType) {
                        if (allText.includes(keyword)) {
                            score += 2
                            foundKeywords.push(keyword)
                        }
                    }
                }

                languageScores[lang] = {
                    score,
                    keywords: [...new Set(foundKeywords)],
                }
            }

            // Find the language with the highest score
            let bestLanguage: 'en' | 'fr' | 'es' | 'de' | 'unknown' = 'unknown'
            let bestScore = 0
            let bestKeywords: string[] = []

            for (const [lang, result] of Object.entries(languageScores)) {
                if (result.score > bestScore) {
                    bestScore = result.score
                    bestLanguage = lang as 'en' | 'fr' | 'es' | 'de'
                    bestKeywords = result.keywords
                }
            }

            // Calculate confidence based on score and number of keywords
            const confidence = Math.min(bestScore / 10, 1.0) // Normalize to 0-1

            return {
                interfaceLanguage: bestLanguage,
                confidence,
                detectedKeywords: bestKeywords,
            }
        } catch (error) {
            console.warn('Error detecting CAPTCHA language:', error)
            return {
                interfaceLanguage: 'unknown',
                confidence: 0,
                detectedKeywords: [],
            }
        }
    }

    /**
     * Get CAPTCHA-related keywords for a specific language
     */
    public static getCAPTCHAKeywords(
        language: 'en' | 'fr' | 'es' | 'de',
    ): CAPTCHAKeywords {
        return this.LANGUAGE_PATTERNS[language] || this.LANGUAGE_PATTERNS.en
    }

    /**
     * Check if text contains CAPTCHA-related keywords in any supported language
     */
    public static containsCAPTCHAKeywords(text: string): boolean {
        const lowerText = text.toLowerCase()

        for (const patterns of Object.values(this.LANGUAGE_PATTERNS)) {
            // Check title keywords
            for (const keyword of patterns.title) {
                if (lowerText.includes(keyword)) {
                    return true
                }
            }
        }

        return false
    }

    /**
     * Get button text patterns for a specific language
     */
    public static getButtonPatterns(language: 'en' | 'fr' | 'es' | 'de'): {
        submit: string[]
        refresh: string[]
        verify: string[]
    } {
        return (
            this.LANGUAGE_PATTERNS[language]?.buttons ||
            this.LANGUAGE_PATTERNS.en.buttons
        )
    }
}
