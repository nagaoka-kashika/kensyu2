import combine from "../../Core/combine.js";
import defined from "../../Core/defined.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import Pass from "../../Renderer/Pass.js";
import CustomShaderStageVS from "../../Shaders/ModelExperimental/CustomShaderStageVS.js";
import CustomShaderStageFS from "../../Shaders/ModelExperimental/CustomShaderStageFS.js";
import VertexAttributeSemantic from "../VertexAttributeSemantic.js";
import AttributeType from "../AttributeType.js";
import AlphaMode from "../AlphaMode.js";
import CustomShaderMode from "./CustomShaderMode.js";

/**
 * The custom shader pipeline stage takes GLSL callbacks from the
 * {@link CustomShader} and inserts them into the overall shader code for the
 * {@link ModelExperimental}. The input to the callback is a struct with many
 * properties that depend on the attributes of the primitive. This shader code
 * is automatically generated by this stage.
 *
 * @namespace CustomShaderPipelineStage
 *
 * @private
 */
var CustomShaderPipelineStage = {};
CustomShaderPipelineStage.name = "CustomShaderPipelineStage"; // Helps with debugging

CustomShaderPipelineStage.STRUCT_ID_ATTRIBUTES_VS = "AttributesVS";
CustomShaderPipelineStage.STRUCT_ID_ATTRIBUTES_FS = "AttributesFS";
CustomShaderPipelineStage.STRUCT_NAME_ATTRIBUTES = "Attributes";
CustomShaderPipelineStage.STRUCT_ID_VERTEX_INPUT = "VertexInput";
CustomShaderPipelineStage.STRUCT_NAME_VERTEX_INPUT = "VertexInput";
CustomShaderPipelineStage.STRUCT_ID_FRAGMENT_INPUT = "FragmentInput";
CustomShaderPipelineStage.STRUCT_NAME_FRAGMENT_INPUT = "FragmentInput";
CustomShaderPipelineStage.FUNCTION_ID_INITIALIZE_INPUT_STRUCT_VS =
  "initializeInputStructVS";
CustomShaderPipelineStage.FUNCTION_SIGNATURE_INITIALIZE_INPUT_STRUCT_VS =
  "void initializeInputStruct(out VertexInput vsInput, ProcessedAttributes attributes)";
CustomShaderPipelineStage.FUNCTION_ID_INITIALIZE_INPUT_STRUCT_FS =
  "initializeInputStructFS";
CustomShaderPipelineStage.FUNCTION_SIGNATURE_INITIALIZE_INPUT_STRUCT_FS =
  "void initializeInputStruct(out FragmentInput fsInput, ProcessedAttributes attributes)";

/**
 * Process a primitive. This modifies the following parts of the render
 * resources:
 * <ul>
 *   <li>Modifies the shader to include the custom shader code to the vertex and fragment shaders</li>
 *   <li>Modifies the shader to include automatically-generated structs that serve as input to the custom shader callbacks </li>
 *   <li>Modifies the shader to include any additional user-defined uniforms</li>
 *   <li>Modifies the shader to include any additional user-defined varyings</li>
 *   <li>Adds any user-defined uniforms to the uniform map</li>
 *   <li>If the user specified a lighting model, the settings are overridden in the render resources</li>
 * </ul>
 * <p>
 * This pipeline stage is designed to fail gracefully where possible. If the
 * primitive does not have the right attributes to satisfy the shader code,
 * defaults will be inferred (when reasonable to do so). If not, the custom
 * shader will be disabled.
 * <p>
 *
 * @param {PrimitiveRenderResources} renderResources The render resources for the primitive
 * @param {ModelComponents.Primitive} primitive The primitive to be rendered
 * @param {FrameState} frameState The frame state.
 * @private
 */
CustomShaderPipelineStage.process = function (
  renderResources,
  primitive,
  frameState
) {
  var shaderBuilder = renderResources.shaderBuilder;
  var customShader = renderResources.model.customShader;

  // Generate lines of code for the shader, but don't add them to the shader
  // yet.
  var generatedCode = generateShaderLines(customShader, primitive);

  // In some corner cases, the primitive may not be compatible with the
  // shader. In this case, skip the custom shader.
  if (!generatedCode.customShaderEnabled) {
    return;
  }
  addLinesToShader(shaderBuilder, customShader, generatedCode);

  // the input to the fragment shader may include a low-precision ECEF position
  if (generatedCode.shouldComputePositionWC) {
    shaderBuilder.addDefine(
      "COMPUTE_POSITION_WC",
      undefined,
      ShaderDestination.BOTH
    );
  }

  if (defined(customShader.vertexShaderText)) {
    shaderBuilder.addDefine(
      "HAS_CUSTOM_VERTEX_SHADER",
      undefined,
      ShaderDestination.VERTEX
    );
  }

  if (defined(customShader.fragmentShaderText)) {
    shaderBuilder.addDefine(
      "HAS_CUSTOM_FRAGMENT_SHADER",
      undefined,
      ShaderDestination.FRAGMENT
    );

    // add defines like CUSTOM_SHADER_MODIFY_MATERIAL
    var shaderModeDefine = CustomShaderMode.getDefineName(customShader.mode);
    shaderBuilder.addDefine(
      shaderModeDefine,
      undefined,
      ShaderDestination.FRAGMENT
    );
  }

  var uniforms = customShader.uniforms;
  for (var uniformName in uniforms) {
    if (uniforms.hasOwnProperty(uniformName)) {
      var uniform = uniforms[uniformName];
      shaderBuilder.addUniform(uniform.type, uniformName);
    }
  }

  var varyings = customShader.varyings;
  for (var varyingName in varyings) {
    if (varyings.hasOwnProperty(varyingName)) {
      var varyingType = varyings[varyingName];
      shaderBuilder.addVarying(varyingType, varyingName);
    }
  }

  // if present, the lighting model overrides the material's lighting model.
  if (defined(customShader.lightingModel)) {
    renderResources.lightingOptions.lightingModel = customShader.lightingModel;
  }

  var alphaOptions = renderResources.alphaOptions;
  if (customShader.isTranslucent) {
    alphaOptions.pass = Pass.TRANSLUCENT;
    alphaOptions.alphaMode = AlphaMode.BLEND;
  } else {
    // Use the default pass (either OPAQUE or 3D_TILES), regardless of whether
    // the material pipeline stage used translucent. The default is configured
    // in AlphaPipelineStage
    alphaOptions.pass = undefined;
    alphaOptions.alphaMode = AlphaMode.OPAQUE;
  }

  renderResources.uniformMap = combine(
    renderResources.uniformMap,
    customShader.uniformMap
  );
};

function getAttributeNames(attributes) {
  var names = {};
  for (var i = 0; i < attributes.length; i++) {
    var attribute = attributes[i];
    var semantic = attribute.semantic;
    var setIndex = attribute.setIndex;

    var variableName;
    if (defined(semantic)) {
      variableName = VertexAttributeSemantic.getVariableName(
        semantic,
        setIndex
      );
    } else {
      // Handle user defined vertex attributes. They must begin with an underscore
      // For example, "_TEMPERATURE" will be converted to "temperature".
      variableName = attribute.name.substring(1).toLowerCase();
    }

    names[variableName] = attribute;
  }
  return names;
}

function generateAttributeField(name, attribute) {
  var attributeType = attribute.type;
  var glslType = AttributeType.getGlslType(attributeType);

  // Fields for the Attribute struct. for example:
  // ["vec3", "normal"];
  return [glslType, name];
}

// GLSL types of standard attribute types when uniquely defined
var attributeTypeLUT = {
  position: "vec3",
  normal: "vec3",
  tangent: "vec3",
  bitangent: "vec3",
  texCoord: "vec2",
  color: "vec3",
  joints: "ivec4",
  weights: "vec4",
};

// Corresponding attribute values
var attributeDefaultValueLUT = {
  position: "vec3(0.0)",
  normal: "vec3(0.0, 0.0, 1.0)",
  tangent: "vec3(1.0, 0.0, 0.0)",
  bitangent: "vec3(0.0, 1.0, 0.0)",
  texCoord: "vec2(0.0)",
  color: "vec4(1.0)",
  joints: "ivec4(0)",
  weights: "vec4(0.0)",
};

function inferAttributeDefaults(attributeName) {
  // remove trailing set indices. E.g. "texCoord_0" -> "texCoord"
  var trimmed = attributeName.replace(/_[0-9]+$/, "");
  // also remove the MC/EC since they will have the same default value
  trimmed = trimmed.replace(/(MC|EC)$/, "");

  var glslType = attributeTypeLUT[trimmed];
  var value = attributeDefaultValueLUT[trimmed];

  // - _CUSTOM_ATTRIBUTE has an unknown type.
  if (!defined(glslType)) {
    return undefined;
  }

  return {
    attributeField: [glslType, attributeName],
    value: value,
  };
}

function generateVertexShaderLines(customShader, namedAttributes, vertexLines) {
  var categories = partitionAttributes(
    namedAttributes,
    customShader.usedVariablesVertex.attributeSet,
    false
  );
  var addToShader = categories.addToShader;
  var needsDefault = categories.missingAttributes;

  var variableName;
  var vertexInitialization;
  var attributeFields = [];
  var initializationLines = [];
  for (variableName in addToShader) {
    if (addToShader.hasOwnProperty(variableName)) {
      var attribute = addToShader[variableName];
      var attributeField = generateAttributeField(variableName, attribute);
      attributeFields.push(attributeField);

      // Initializing attribute structs are just a matter of copying the
      // attribute or varying: E.g.:
      // "    vsInput.attributes.position = a_position;"
      vertexInitialization =
        "vsInput.attributes." +
        variableName +
        " = attributes." +
        variableName +
        ";";
      initializationLines.push(vertexInitialization);
    }
  }

  for (var i = 0; i < needsDefault.length; i++) {
    variableName = needsDefault[i];
    var attributeDefaults = inferAttributeDefaults(variableName);
    if (!defined(attributeDefaults)) {
      CustomShaderPipelineStage._oneTimeWarning(
        "CustomShaderPipelineStage.incompatiblePrimitiveVS",
        "Primitive is missing attribute " +
          variableName +
          ", disabling custom vertex shader"
      );
      // This primitive isn't compatible with the shader. Return early
      // to skip the vertex shader
      return;
    }

    attributeFields.push(attributeDefaults.attributeField);
    vertexInitialization =
      "vsInput.attributes." +
      variableName +
      " = " +
      attributeDefaults.value +
      ";";
    initializationLines.push(vertexInitialization);
  }

  vertexLines.enabled = true;
  vertexLines.attributeFields = attributeFields;
  vertexLines.initializationLines = initializationLines;
}

function generatePositionBuiltins(customShader) {
  var attributeFields = [];
  var initializationLines = [];
  var usedVariables = customShader.usedVariablesFragment.attributeSet;

  // Model space position is the same position as in the glTF accessor,
  // this is already added to the shader with other attributes.

  // World coordinates in ECEF coordinates. Note that this is
  // low precision (32-bit floats) on the GPU.
  if (usedVariables.hasOwnProperty("positionWC")) {
    attributeFields.push(["vec3", "positionWC"]);
    initializationLines.push(
      "fsInput.attributes.positionWC = attributes.positionWC;"
    );
  }

  // position in eye coordinates
  if (usedVariables.hasOwnProperty("positionEC")) {
    attributeFields.push(["vec3", "positionEC"]);
    initializationLines.push(
      "fsInput.attributes.positionEC = attributes.positionEC;"
    );
  }

  return {
    attributeFields: attributeFields,
    initializationLines: initializationLines,
  };
}

function generateFragmentShaderLines(
  customShader,
  namedAttributes,
  fragmentLines
) {
  var categories = partitionAttributes(
    namedAttributes,
    customShader.usedVariablesFragment.attributeSet,
    true
  );
  var addToShader = categories.addToShader;
  var needsDefault = categories.missingAttributes;

  var variableName;
  var fragmentInitialization;
  var attributeFields = [];
  var initializationLines = [];
  for (variableName in addToShader) {
    if (addToShader.hasOwnProperty(variableName)) {
      var attribute = addToShader[variableName];

      var attributeField = generateAttributeField(variableName, attribute);
      attributeFields.push(attributeField);

      // Initializing attribute structs are just a matter of copying the
      // value from the processed attributes
      // "    fsInput.attributes.positionMC = attributes.positionMC;"
      fragmentInitialization =
        "fsInput.attributes." +
        variableName +
        " = attributes." +
        variableName +
        ";";
      initializationLines.push(fragmentInitialization);
    }
  }

  for (var i = 0; i < needsDefault.length; i++) {
    variableName = needsDefault[i];
    var attributeDefaults = inferAttributeDefaults(variableName);
    if (!defined(attributeDefaults)) {
      CustomShaderPipelineStage._oneTimeWarning(
        "CustomShaderPipelineStage.incompatiblePrimitiveFS",
        "Primitive is missing attribute " +
          variableName +
          ", disabling custom fragment shader."
      );

      // This primitive isn't compatible with the shader. Return early
      // so the fragment shader is skipped
      return;
    }

    attributeFields.push(attributeDefaults.attributeField);
    fragmentInitialization =
      "fsInput.attributes." +
      variableName +
      " = " +
      attributeDefaults.value +
      ";";
    initializationLines.push(fragmentInitialization);
  }

  // Built-ins for positions in various coordinate systems.
  var positionBuiltins = generatePositionBuiltins(customShader);

  fragmentLines.enabled = true;
  fragmentLines.attributeFields = attributeFields.concat(
    positionBuiltins.attributeFields
  );
  fragmentLines.initializationLines = positionBuiltins.initializationLines.concat(
    initializationLines
  );
}

// These attributes are derived from positionMC, and are handled separately
// from other attributes
var builtinAttributes = {
  positionWC: true,
  positionEC: true,
};

function partitionAttributes(
  primitiveAttributes,
  shaderAttributeSet,
  isFragmentShader
) {
  // shaderAttributes = set of all attributes used in the shader
  // primitiveAttributes = set of all the primitive's attributes
  // partition into three categories:
  // - addToShader = shaderAttributes intersect primitiveAttributes
  // - missingAttributes = shaderAttributes - primitiveAttributes - builtinAttributes
  // - unneededAttributes = (primitiveAttributes - shaderAttributes) U builtinAttributes
  //
  // addToShader are attributes that should be added to the shader.
  // missingAttributes are attributes for which we need to provide a default value
  // unneededAttributes are other attributes that can be skipped.

  var renamed;
  var attributeName;
  var addToShader = {};
  for (attributeName in primitiveAttributes) {
    if (primitiveAttributes.hasOwnProperty(attributeName)) {
      var attribute = primitiveAttributes[attributeName];

      // normals and tangents are in model coordinates in the attributes but
      // in eye coordinates in the fragment shader.
      renamed = attributeName;
      if (isFragmentShader && attributeName === "normalMC") {
        renamed = "normalEC";
      } else if (isFragmentShader && attributeName === "tangentMC") {
        renamed = "tangentEC";
      }

      if (shaderAttributeSet.hasOwnProperty(renamed)) {
        addToShader[renamed] = attribute;
      }
    }
  }

  var missingAttributes = [];
  for (attributeName in shaderAttributeSet) {
    if (shaderAttributeSet.hasOwnProperty(attributeName)) {
      if (builtinAttributes.hasOwnProperty(attributeName)) {
        // Builtins are handled separately from attributes, so skip them here
        continue;
      }

      // normals and tangents are in model coordinates in the attributes but
      // in eye coordinates in the fragment shader.
      renamed = attributeName;
      if (isFragmentShader && attributeName === "normalEC") {
        renamed = "normalMC";
      } else if (isFragmentShader && attributeName === "tangentEC") {
        renamed = "tangentMC";
      }

      if (!primitiveAttributes.hasOwnProperty(renamed)) {
        missingAttributes.push(attributeName);
      }
    }
  }

  return {
    addToShader: addToShader,
    missingAttributes: missingAttributes,
  };
}

function generateShaderLines(customShader, primitive) {
  // Assume shader code is disabled unless proven otherwise
  var vertexLines = {
    enabled: false,
  };
  var fragmentLines = {
    enabled: false,
  };

  // Attempt to generate vertex and fragment shader lines before adding any
  // code to the shader.
  var namedAttributes = getAttributeNames(primitive.attributes);
  if (defined(customShader.vertexShaderText)) {
    generateVertexShaderLines(customShader, namedAttributes, vertexLines);
  }

  if (defined(customShader.fragmentShaderText)) {
    generateFragmentShaderLines(customShader, namedAttributes, fragmentLines);
  }

  // positionWC must be computed in the vertex shader
  // for use in the fragmentShader. However, this can be skipped if:
  // - positionWC isn't used in the fragment shader
  // - or the fragment shader is disabled
  var attributeSetFS = customShader.usedVariablesFragment.attributeSet;
  var shouldComputePositionWC =
    attributeSetFS.hasOwnProperty("positionWC") && fragmentLines.enabled;

  // Return any generated shader code along with some flags to indicate which
  // defines should be added.
  return {
    vertexLines: vertexLines,
    fragmentLines: fragmentLines,
    vertexLinesEnabled: vertexLines.enabled,
    fragmentLinesEnabled: fragmentLines.enabled,
    customShaderEnabled: vertexLines.enabled || fragmentLines.enabled,
    shouldComputePositionWC: shouldComputePositionWC,
  };
}

function addVertexLinesToShader(shaderBuilder, vertexLines) {
  // Vertex Lines ---------------------------------------------------------

  var i;
  var structId = CustomShaderPipelineStage.STRUCT_ID_ATTRIBUTES_VS;
  shaderBuilder.addStruct(
    structId,
    CustomShaderPipelineStage.STRUCT_NAME_ATTRIBUTES,
    ShaderDestination.VERTEX
  );

  var attributeFields = vertexLines.attributeFields;
  for (i = 0; i < attributeFields.length; i++) {
    var field = attributeFields[i];
    var glslType = field[0];
    var variableName = field[1];
    shaderBuilder.addStructField(structId, glslType, variableName);
  }

  // This could be hard-coded, but the symmetry with other structs makes unit
  // tests more convenient
  structId = CustomShaderPipelineStage.STRUCT_ID_VERTEX_INPUT;
  shaderBuilder.addStruct(
    structId,
    CustomShaderPipelineStage.STRUCT_NAME_VERTEX_INPUT,
    ShaderDestination.VERTEX
  );
  shaderBuilder.addStructField(
    structId,
    CustomShaderPipelineStage.STRUCT_NAME_ATTRIBUTES,
    "attributes"
  );

  var functionId =
    CustomShaderPipelineStage.FUNCTION_ID_INITIALIZE_INPUT_STRUCT_VS;
  shaderBuilder.addFunction(
    functionId,
    CustomShaderPipelineStage.FUNCTION_SIGNATURE_INITIALIZE_INPUT_STRUCT_VS,
    ShaderDestination.VERTEX
  );

  var initializationLines = vertexLines.initializationLines;
  shaderBuilder.addFunctionLines(functionId, initializationLines);
}

function addFragmentLinesToShader(shaderBuilder, fragmentLines) {
  var i;
  var structId = CustomShaderPipelineStage.STRUCT_ID_ATTRIBUTES_FS;
  shaderBuilder.addStruct(
    structId,
    CustomShaderPipelineStage.STRUCT_NAME_ATTRIBUTES,
    ShaderDestination.FRAGMENT
  );

  var field;
  var glslType;
  var variableName;
  var attributeFields = fragmentLines.attributeFields;
  for (i = 0; i < attributeFields.length; i++) {
    field = attributeFields[i];
    glslType = field[0];
    variableName = field[1];
    shaderBuilder.addStructField(structId, glslType, variableName);
  }

  structId = CustomShaderPipelineStage.STRUCT_ID_FRAGMENT_INPUT;
  shaderBuilder.addStruct(
    structId,
    CustomShaderPipelineStage.STRUCT_NAME_FRAGMENT_INPUT,
    ShaderDestination.FRAGMENT
  );
  shaderBuilder.addStructField(
    structId,
    CustomShaderPipelineStage.STRUCT_NAME_ATTRIBUTES,
    "attributes"
  );

  var functionId =
    CustomShaderPipelineStage.FUNCTION_ID_INITIALIZE_INPUT_STRUCT_FS;
  shaderBuilder.addFunction(
    functionId,
    CustomShaderPipelineStage.FUNCTION_SIGNATURE_INITIALIZE_INPUT_STRUCT_FS,
    ShaderDestination.FRAGMENT
  );

  var initializationLines = fragmentLines.initializationLines;
  shaderBuilder.addFunctionLines(functionId, initializationLines);
}

function addLinesToShader(shaderBuilder, customShader, generatedCode) {
  var vertexLines = generatedCode.vertexLines;
  if (vertexLines.enabled) {
    addVertexLinesToShader(shaderBuilder, vertexLines);

    shaderBuilder.addVertexLines([
      "#line 0",
      customShader.vertexShaderText,
      CustomShaderStageVS,
    ]);
  }

  var fragmentLines = generatedCode.fragmentLines;
  if (fragmentLines.enabled) {
    addFragmentLinesToShader(shaderBuilder, fragmentLines);

    shaderBuilder.addFragmentLines([
      "#line 0",
      customShader.fragmentShaderText,
      CustomShaderStageFS,
    ]);
  }
}

// exposed for testing.
CustomShaderPipelineStage._oneTimeWarning = oneTimeWarning;

export default CustomShaderPipelineStage;
