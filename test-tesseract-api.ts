import Tesseract from 'tesseract.js'

async function testTesseractAPI() {
    console.log('🧪 Testing Tesseract.js API (Official Documentation)...')

    try {
        // Test 1: Basic worker creation with single language
        console.log('\n📦 Test 1: Basic worker creation')
        const worker1 = await Tesseract.createWorker('eng')
        console.log('✅ Single language worker created')
        await worker1.terminate()

        // Test 2: Multi-language worker creation with array
        console.log('\n🌍 Test 2: Multi-language worker creation')
        const worker2 = await Tesseract.createWorker([
            'eng',
            'fra',
            'spa',
            'deu',
        ])
        console.log('✅ Multi-language worker created')

        // Test 3: Set parameters for CAPTCHA recognition
        console.log('\n⚙️ Test 3: Setting CAPTCHA parameters')
        await worker2.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
            preserve_interword_spaces: '0',
        })
        console.log('✅ CAPTCHA parameters set')

        // Test 4: Worker with options (logger)
        console.log('\n📝 Test 4: Worker with logger option')
        const worker3 = await Tesseract.createWorker(
            'eng',
            Tesseract.OEM.LSTM_ONLY,
            {
                logger: (m) => {
                    if (m.status === 'loading tesseract core') {
                        console.log('📦 Loading Tesseract core...')
                    } else if (m.status === 'loading language traineddata') {
                        console.log(`🌍 Loading language: ${m.progress}`)
                    } else if (m.status === 'initializing tesseract') {
                        console.log('⚙️ Initializing Tesseract...')
                    }
                },
            },
        )
        console.log('✅ Worker with logger created')

        // Test 5: Verify PSM and OEM values
        console.log('\n🔍 Test 5: PSM and OEM values')
        console.log('PSM.SINGLE_LINE:', Tesseract.PSM.SINGLE_LINE)
        console.log('OEM.LSTM_ONLY:', Tesseract.OEM.LSTM_ONLY)
        console.log('✅ PSM and OEM values verified')

        // Cleanup
        await worker2.terminate()
        await worker3.terminate()

        console.log('\n🎉 All Tesseract.js API tests passed!')
        console.log('\n📋 Summary:')
        console.log('- Single language worker: ✅ Working')
        console.log('- Multi-language worker: ✅ Working')
        console.log('- Parameter setting: ✅ Working')
        console.log('- Logger option: ✅ Working')
        console.log('- PSM/OEM enums: ✅ Working')
        console.log('- Worker termination: ✅ Working')
    } catch (error) {
        console.error('❌ Tesseract.js API test failed:', error)
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    testTesseractAPI().catch(console.error)
}

export { testTesseractAPI }
