# The native app: ampcore's chain inside JUCE (epic #38, milestone 2).
#
# Built as a plugin with a Standalone format, so the AU and VST3 of
# milestone 4 come from this same code by adding to FORMATS rather than by
# writing a second app.
#
# JUCE 9 is used under its AGPLv3 option, the licence this project is under.
# It is fetched as a release tarball checked against its hash, into
# native/.deps rather than the build directory, so a fresh build does not
# download it again.
#
#   cmake -B build -G Ninja && cmake --build build      (CMake 3.22 or later)
#   open build/Amp_artefacts/Release/Standalone/Amp.app

cmake_minimum_required(VERSION 3.22)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Oldest macOS to run on")
project(AmpApp VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)
set(FETCHCONTENT_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.deps" CACHE PATH "" FORCE)
FetchContent_Declare(juce
  URL https://github.com/juce-framework/JUCE/archive/refs/tags/9.0.4.tar.gz
  URL_HASH SHA256=e2bee25d5c776118aea550ad168a3dc9520c0669a79bd9f5a72b9f404ee1c40a
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(juce)

# The DSP, with its own flags — no fast-math, no FMA contraction — kept on
# its own target so JUCE's recommended flags never reach it.
add_subdirectory(../ampcore ampcore EXCLUDE_FROM_ALL)

juce_add_plugin(Amp
  PRODUCT_NAME "Amp"
  COMPANY_NAME "Theodore Van Rooy"
  BUNDLE_ID com.greentheo.amp
  FORMATS Standalone
  PLUGIN_MANUFACTURER_CODE Gthe
  PLUGIN_CODE Amp1
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT TRUE
  NEEDS_MIDI_OUTPUT FALSE
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Amp plays your guitar, which arrives through an audio input."
  COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(Amp PRIVATE src/Processor.cpp)

target_compile_definitions(Amp PUBLIC
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(Amp
  PRIVATE
    ampcore
    juce::juce_audio_utils
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)
