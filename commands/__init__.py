from .help_command import help_command
from .send_command import send_command
from .cmd_command import cmd_command
from .respawn_command import respawn_command
from .restart_command import restart_command
from .move_command import move_command, jump_command, stop_command, goto_command, follow_command
from .action_command import attack_command, dig_command, place_command, interact_command, mount_command, dismount_command, use_command, usehold_command, look_command, cancel_command, sneak_command, sprint_command, drop_command, dropall_command, clear_command, slot_command
from .test_command import test_command
from .ping_command import ping_command


def register_all():
    """向 CommandManager 注册全部命令。"""
    from command_manager import CommandManager
    CommandManager.register(help_command)
    CommandManager.register(send_command)
    CommandManager.register(cmd_command)
    CommandManager.register(respawn_command)
    CommandManager.register(restart_command)
    CommandManager.register(move_command)
    CommandManager.register(jump_command)
    CommandManager.register(stop_command)
    CommandManager.register(goto_command)
    CommandManager.register(follow_command)
    CommandManager.register(attack_command)
    CommandManager.register(dig_command)
    CommandManager.register(place_command)
    CommandManager.register(interact_command)
    CommandManager.register(mount_command)
    CommandManager.register(dismount_command)
    CommandManager.register(use_command)
    CommandManager.register(usehold_command)
    CommandManager.register(look_command)
    CommandManager.register(cancel_command)
    CommandManager.register(sneak_command)
    CommandManager.register(sprint_command)
    CommandManager.register(drop_command)
    CommandManager.register(dropall_command)
    CommandManager.register(clear_command)
    CommandManager.register(test_command)
    CommandManager.register(ping_command)
    CommandManager.register(slot_command)