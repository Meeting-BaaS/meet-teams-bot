#!/usr/bin/env node

const { testWithSampleFiles } = require('../../build/src/utils/CalculVideoOffset');

async function testSyncDetection() {
    try {
        console.log('🔍 Testing sync detection with real files...\n');
        
        const result = await testWithSampleFiles();
        
        console.log('\n📊 Results:');
        console.log(`   Audio beep: ${result.audioTimestamp.toFixed(3)}s`);
        console.log(`   Video flash: ${result.videoTimestamp.toFixed(3)}s`);
        console.log(`   Offset: ${result.offsetSeconds.toFixed(3)}s`);
        console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        
        // Validate against expected values
        const expectedAudio = 0.7; // From manual analysis
        const expectedVideo = 6.48; // From manual analysis
        const expectedOffset = expectedVideo - expectedAudio;
        
        console.log('\n🎯 Expected values:');
        console.log(`   Audio beep: ${expectedAudio.toFixed(3)}s`);
        console.log(`   Video flash: ${expectedVideo.toFixed(3)}s`);
        console.log(`   Offset: ${expectedOffset.toFixed(3)}s`);
        
        const audioDiff = Math.abs(result.audioTimestamp - expectedAudio);
        const videoDiff = Math.abs(result.videoTimestamp - expectedVideo);
        const offsetDiff = Math.abs(result.offsetSeconds - expectedOffset);
        
        console.log('\n📈 Differences:');
        console.log(`   Audio: ${audioDiff.toFixed(3)}s`);
        console.log(`   Video: ${videoDiff.toFixed(3)}s`);
        console.log(`   Offset: ${offsetDiff.toFixed(3)}s`);
        
        // Check if detection is accurate (within 0.5s tolerance)
        const tolerance = 0.5;
        const isAccurate = audioDiff < tolerance && videoDiff < tolerance;
        
        if (isAccurate) {
            console.log('\n✅ Detection is accurate!');
        } else {
            console.log('\n❌ Detection needs improvement');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

testSyncDetection(); 