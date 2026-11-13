-- Profil « rail » minimal pour OSRM : sert uniquement à dessiner les trajets des trains sur les voies
-- ferrées OpenStreetMap (pas à calculer des temps de parcours, qui viennent des horaires SNCF).
api_version = 4

function setup()
  return {
    properties = {
      weight_name = 'duration',
      max_speed_for_map_matching = 220 / 3.6,
      use_turn_restrictions = false,
      continue_straight_at_waypoint = true,
      left_hand_driving = false,
    },
    default_mode = mode.train,
    default_speed = 100,
  }
end

function process_node(profile, node, result, relations)
end

function process_way(profile, way, result, relations)
  local railway = way:get_value_by_key('railway')
  if railway ~= 'rail' and railway ~= 'light_rail' then
    return
  end
  local service = way:get_value_by_key('service')
  local usage = way:get_value_by_key('usage')
  -- voies de triage et embranchements industriels exclus ; voies principales et de gare conservées
  if service == 'yard' or service == 'spur' or usage == 'industrial' or usage == 'military' or usage == 'test' then
    return
  end
  local speed = 100
  if service == 'siding' or service == 'crossover' then
    speed = 30
  elseif usage == 'branch' then
    speed = 80
  elseif usage == 'main' then
    speed = 140
  end
  result.forward_mode = mode.train
  result.backward_mode = mode.train
  result.forward_speed = speed
  result.backward_speed = speed
  result.name = way:get_value_by_key('name') or ''
end

function process_turn(profile, turn)
  -- un train ne fait pas demi-tour ni ne tourne à angle droit à un aiguillage : pénalités
  -- (modérées : des valeurs trop fortes débordent les compteurs internes d'OSRM)
  if turn.is_u_turn then
    turn.duration = turn.duration + 300
  elseif math.abs(turn.angle) > 45 then
    turn.duration = turn.duration + 60
  end
end

return {
  setup = setup,
  process_way = process_way,
  process_node = process_node,
  process_turn = process_turn,
}
