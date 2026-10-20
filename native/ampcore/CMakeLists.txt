# ampcore: the amp's DSP as a plain C++ library, with no framework in it.
#
# Kept framework-free on purpose. The native app wraps it in JUCE; the
# browser build can later compile the same code to WebAssembly, so both run
# one implementation instead of two that drift apart.

cmake_minimum_required(VERSION 3.12)
project(ampcore CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(ampcore STATIC src/tonestack.cpp src/amp.cpp)
target_include_directories(ampcore PUBLIC include)
# No -ffast-math. It licenses the compiler to reassociate floating point,
# and the null test against the browser build depends on the arithmetic
# being done in the order it is written.
target_compile_options(ampcore PRIVATE -Wall -Wextra -O2)

add_executable(ampcore-render tools/render.cpp)
target_link_libraries(ampcore-render PRIVATE ampcore)
target_compile_options(ampcore-render PRIVATE -O2)
